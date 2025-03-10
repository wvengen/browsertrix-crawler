import child_process, { ChildProcess, StdioOptions } from "child_process";
import path from "path";
import fs, { WriteStream } from "fs";
import os from "os";
import fsp, { FileHandle } from "fs/promises";

import {
  RedisCrawlState,
  LoadState,
  QueueState,
  PageState,
  WorkerId,
  PageCallbacks,
} from "./util/state.js";

import Sitemapper from "sitemapper";
import yaml from "js-yaml";

import * as warcio from "warcio";

import { HealthChecker } from "./util/healthcheck.js";
import { TextExtractViaSnapshot } from "./util/textextract.js";
import {
  initStorage,
  getFileSize,
  getDirSize,
  interpolateFilename,
  checkDiskUtilization,
  S3StorageSync,
} from "./util/storage.js";
import { ScreenCaster, WSTransport } from "./util/screencaster.js";
import { Screenshots } from "./util/screenshots.js";
import { parseArgs } from "./util/argParser.js";
import { initRedis } from "./util/redis.js";
import { logger, formatErr } from "./util/logger.js";
import { WorkerOpts, WorkerState, runWorkers } from "./util/worker.js";
import { sleep, timedRun, secondsElapsed } from "./util/timing.js";
import { collectAllFileSources } from "./util/file_reader.js";

import { Browser } from "./util/browser.js";

import {
  ADD_LINK_FUNC,
  BEHAVIOR_LOG_FUNC,
  HTML_TYPES,
  DEFAULT_SELECTORS,
} from "./util/constants.js";

import { AdBlockRules, BlockRules } from "./util/blockrules.js";
import { OriginOverride } from "./util/originoverride.js";

// to ignore HTTPS error for HEAD check
import { Agent as HTTPAgent } from "http";
import { Agent as HTTPSAgent } from "https";
import { CDPSession, Frame, HTTPRequest, Page } from "puppeteer-core";

const HTTPS_AGENT = new HTTPSAgent({
  rejectUnauthorized: false,
});

const HTTP_AGENT = new HTTPAgent();

const behaviors = fs.readFileSync(
  new URL(
    "../node_modules/browsertrix-behaviors/dist/behaviors.js",
    import.meta.url,
  ),
  { encoding: "utf8" },
);

const FETCH_TIMEOUT_SECS = 30;
const PAGE_OP_TIMEOUT_SECS = 5;

const POST_CRAWL_STATES = [
  "generate-wacz",
  "uploading-wacz",
  "generate-cdx",
  "generate-warc",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogDetails = Record<string, any>;

type PageEntry = {
  id: string;
  url: string;
  title?: string;
  loadState?: number;
  mime?: string;
  seed?: boolean;
  text?: string;
  favIconUrl?: string;
  ts?: string;
  status?: number;
};

// ============================================================================
export class Crawler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  origConfig: any;

  collDir: string;
  logDir: string;
  logFilename: string;

  headers: Record<string, string> = {};

  crawlState!: RedisCrawlState;

  pagesFH?: FileHandle | null = null;
  logFH!: WriteStream;

  crawlId: string;

  startTime: number;

  limitHit = false;
  pageLimit: number;

  saveStateFiles: string[] = [];
  lastSaveTime: number;

  maxPageTime: number;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emulateDevice: any = {};

  captureBasePrefix = "";

  infoString!: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gotoOpts: Record<string, any>;

  pagesDir: string;
  pagesFile: string;

  blockRules: BlockRules | null;
  adBlockRules: AdBlockRules | null;

  healthChecker: HealthChecker | null = null;
  originOverride: OriginOverride | null = null;

  screencaster: ScreenCaster | null = null;

  interrupted = false;
  finalExit = false;
  uploadAndDeleteLocal = false;
  done = false;

  customBehaviors = "";
  behaviorsChecked = false;
  behaviorLastLine?: string;

  browser: Browser;
  storage: S3StorageSync | null = null;

  maxHeapUsed = 0;
  maxHeapTotal = 0;

  warcPrefix: string;

  driver!: (opts: {
    page: Page;
    data: PageState;
    // eslint-disable-next-line no-use-before-define
    crawler: Crawler;
  }) => NonNullable<unknown>;

  constructor() {
    const res = parseArgs();
    this.params = res.parsed;
    this.origConfig = res.origConfig;

    // root collections dir
    this.collDir = path.join(
      this.params.cwd,
      "collections",
      this.params.collection,
    );
    this.logDir = path.join(this.collDir, "logs");
    this.logFilename = path.join(
      this.logDir,
      `crawl-${new Date().toISOString().replace(/[^\d]/g, "")}.log`,
    );

    const debugLogging = this.params.logging.includes("debug");
    logger.setDebugLogging(debugLogging);
    logger.setLogLevel(this.params.logLevel);
    logger.setContext(this.params.logContext);
    logger.setExcludeContext(this.params.logExcludeContext);

    // if automatically restarts on error exit code,
    // exit with 0 from fatal by default, to avoid unnecessary restart
    // otherwise, exit with default fatal exit code
    if (this.params.restartsOnError) {
      logger.setDefaultFatalExitCode(0);
    }

    logger.debug("Writing log to: " + this.logFilename, {}, "general");

    this.headers = {};

    // pages file
    this.pagesFH = null;

    this.crawlId = process.env.CRAWL_ID || os.hostname();

    this.startTime = Date.now();

    // was the limit hit?
    this.limitHit = false;
    this.pageLimit = this.params.pageLimit;

    // resolve maxPageLimit and ensure pageLimit is no greater than maxPageLimit
    if (this.params.maxPageLimit) {
      this.pageLimit = this.pageLimit
        ? Math.min(this.pageLimit, this.params.maxPageLimit)
        : this.params.maxPageLimit;
    }

    this.saveStateFiles = [];
    this.lastSaveTime = 0;

    // sum of page load + behavior timeouts + 2 x fetch + cloudflare + link extraction timeouts + extra page delay
    // if exceeded, will interrupt and move on to next page (likely behaviors or some other operation is stuck)
    this.maxPageTime =
      this.params.pageLoadTimeout +
      this.params.behaviorTimeout +
      FETCH_TIMEOUT_SECS * 2 +
      PAGE_OP_TIMEOUT_SECS * 2 +
      this.params.pageExtraDelay;

    this.emulateDevice = this.params.emulateDevice || {};

    //this.captureBasePrefix = `http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}/${this.params.collection}/record`;
    //this.capturePrefix = "";//process.env.NO_PROXY ? "" : this.captureBasePrefix + "/id_/";
    //this.captureBasePrefix = "";

    this.gotoOpts = {
      waitUntil: this.params.waitUntil,
      timeout: this.params.pageLoadTimeout * 1000,
    };

    // pages directory
    this.pagesDir = path.join(this.collDir, "pages");

    // pages file
    this.pagesFile = path.join(this.pagesDir, "pages.jsonl");

    this.blockRules = null;
    this.adBlockRules = null;

    this.healthChecker = null;

    this.interrupted = false;
    this.finalExit = false;
    this.uploadAndDeleteLocal = false;

    this.done = false;

    this.customBehaviors = "";

    this.browser = new Browser();

    this.warcPrefix = process.env.WARC_PREFIX || this.params.warcPrefix || "";

    if (this.warcPrefix) {
      this.warcPrefix += "-" + this.crawlId + "-";
    }
  }

  configureUA() {
    // override userAgent
    if (this.params.userAgent) {
      this.emulateDevice.userAgent = this.params.userAgent;
      return this.params.userAgent;
    }

    // if device set, it overrides the default Chrome UA
    if (!this.emulateDevice.userAgent) {
      this.emulateDevice.userAgent = this.browser.getDefaultUA();
    }

    // suffix to append to default userAgent
    if (this.params.userAgentSuffix) {
      this.emulateDevice.userAgent += " " + this.params.userAgentSuffix;
    }

    return this.emulateDevice.userAgent;
  }

  async initCrawlState() {
    const redisUrl = this.params.redisStoreUrl || "redis://localhost:6379/0";

    if (!redisUrl.startsWith("redis://")) {
      logger.fatal(
        "stateStoreUrl must start with redis:// -- Only redis-based store currently supported",
      );
    }

    let redis;

    while (true) {
      try {
        redis = await initRedis(redisUrl);
        break;
      } catch (e) {
        //logger.fatal("Unable to connect to state store Redis: " + redisUrl);
        logger.warn(`Waiting for redis at ${redisUrl}`, {}, "state");
        await sleep(1);
      }
    }

    logger.debug(
      `Storing state via Redis ${redisUrl} @ key prefix "${this.crawlId}"`,
      {},
      "state",
    );

    logger.debug(`Max Page Time: ${this.maxPageTime} seconds`, {}, "state");

    this.crawlState = new RedisCrawlState(
      redis,
      this.params.crawlId,
      this.maxPageTime,
      os.hostname(),
    );

    // clear any pending URLs from this instance
    await this.crawlState.clearOwnPendingLocks();

    if (this.params.saveState === "always" && this.params.saveStateInterval) {
      logger.debug(
        `Saving crawl state every ${this.params.saveStateInterval} seconds, keeping last ${this.params.saveStateHistory} states`,
        {},
        "state",
      );
    }

    if (this.params.logErrorsToRedis) {
      logger.setLogErrorsToRedis(true);
      logger.setCrawlState(this.crawlState);
    }

    return this.crawlState;
  }

  initScreenCaster() {
    let transport;

    if (this.params.screencastPort) {
      transport = new WSTransport(this.params.screencastPort);
      logger.debug(
        `Screencast server started on: ${this.params.screencastPort}`,
        {},
        "screencast",
      );
    }
    // } else if (this.params.redisStoreUrl && this.params.screencastRedis) {
    //   transport = new RedisPubSubTransport(this.params.redisStoreUrl, this.crawlId);
    //   logger.debug("Screencast enabled via redis pubsub", {}, "screencast");
    // }

    if (!transport) {
      return null;
    }

    return new ScreenCaster(transport, this.params.workers);
  }

  launchRedis() {
    let redisStdio: StdioOptions;

    if (this.params.logging.includes("redis")) {
      const redisStderr = fs.openSync(path.join(this.logDir, "redis.log"), "a");
      redisStdio = [process.stdin, redisStderr, redisStderr];
    } else {
      redisStdio = "ignore";
    }

    let redisArgs: string[] = [];
    if (this.params.debugAccessRedis) {
      redisArgs = ["--protected-mode", "no"];
    }

    return child_process.spawn("redis-server", redisArgs, {
      cwd: "/tmp/",
      stdio: redisStdio,
    });
  }

  async bootstrap() {
    const subprocesses: ChildProcess[] = [];

    subprocesses.push(this.launchRedis());

    //const initRes = child_process.spawnSync("wb-manager", ["init", this.params.collection], {cwd: this.params.cwd});

    //if (initRes.status) {
    //  logger.info("wb-manager init failed, collection likely already exists");
    //}

    fs.mkdirSync(this.logDir, { recursive: true });
    this.logFH = fs.createWriteStream(this.logFilename);
    logger.setExternalLogStream(this.logFH);

    this.infoString = await this.getInfoString();
    logger.info(this.infoString);

    logger.info("Seeds", this.params.scopedSeeds);

    if (this.params.profile) {
      logger.info("With Browser Profile", { url: this.params.profile });
    }

    if (this.params.overwrite) {
      logger.debug(`Clearing ${this.collDir} before starting`);
      try {
        fs.rmSync(this.collDir, { recursive: true, force: true });
      } catch (e) {
        logger.error(`Unable to clear ${this.collDir}`, e);
      }
    }

    if (this.params.customBehaviors) {
      this.customBehaviors = this.loadCustomBehaviors(
        this.params.customBehaviors,
      );
    }

    this.headers = { "User-Agent": this.configureUA() };

    process.on("exit", () => {
      for (const proc of subprocesses) {
        proc.kill();
      }
    });

    child_process.spawn("socat", [
      "tcp-listen:9222,reuseaddr,fork",
      "tcp:localhost:9221",
    ]);

    if (!this.params.headless && !process.env.NO_XVFB) {
      child_process.spawn("Xvfb", [
        process.env.DISPLAY || "",
        "-listen",
        "tcp",
        "-screen",
        "0",
        process.env.GEOMETRY || "",
        "-ac",
        "+extension",
        "RANDR",
      ]);
    }
  }

  extraChromeArgs() {
    const args = [];
    if (this.params.lang) {
      args.push(`--accept-lang=${this.params.lang}`);
    }
    return args;
  }

  async run() {
    await this.bootstrap();

    let status = "done";
    let exitCode = 0;

    try {
      await this.crawl();
      const finished = await this.crawlState.isFinished();
      const stopped = await this.crawlState.isCrawlStopped();
      const canceled = await this.crawlState.isCrawlCanceled();
      if (!finished) {
        if (canceled) {
          status = "canceled";
        } else if (stopped) {
          status = "done";
          logger.info("Crawl gracefully stopped on request");
        } else if (this.interrupted) {
          status = "interrupted";
          exitCode = 11;
        }
      }
    } catch (e) {
      logger.error("Crawl failed", e);
      exitCode = 9;
      status = "failing";
      if (await this.crawlState.incFailCount()) {
        status = "failed";
      }
    } finally {
      await this.setStatusAndExit(exitCode, status);
    }
  }

  _behaviorLog(
    { data, type }: { data: string; type: string },
    pageUrl: string,
    workerid: WorkerId,
  ) {
    let behaviorLine;
    let message;
    let details;

    const logDetails = { page: pageUrl, workerid };

    if (typeof data === "string") {
      message = data;
      details = logDetails;
    } else {
      message = type === "info" ? "Behavior log" : "Behavior debug";
      details =
        typeof data === "object"
          ? { ...(data as object), ...logDetails }
          : logDetails;
    }

    switch (type) {
      case "info":
        behaviorLine = JSON.stringify(data);
        if (behaviorLine !== this.behaviorLastLine) {
          logger.info(message, details, "behaviorScript");
          this.behaviorLastLine = behaviorLine;
        }
        break;

      case "error":
        logger.error(message, details, "behaviorScript");
        break;

      case "debug":
      default:
        logger.debug(message, details, "behaviorScript");
    }
  }

  isInScope(
    {
      seedId,
      url,
      depth,
      extraHops,
    }: { seedId: number; url: string; depth: number; extraHops: number },
    logDetails = {},
  ) {
    const seed = this.params.scopedSeeds[seedId];

    return seed.isIncluded(url, depth, extraHops, logDetails);
  }

  async setupPage({
    page,
    cdp,
    workerid,
    callbacks,
  }: {
    page: Page;
    cdp: CDPSession;
    workerid: WorkerId;
    callbacks: PageCallbacks;
  }) {
    await this.browser.setupPage({ page, cdp });

    if (
      (this.adBlockRules && this.params.blockAds) ||
      this.blockRules ||
      this.originOverride
    ) {
      await page.setRequestInterception(true);

      if (this.adBlockRules && this.params.blockAds) {
        await this.adBlockRules.initPage(this.browser, page);
      }

      if (this.blockRules) {
        await this.blockRules.initPage(this.browser, page);
      }

      if (this.originOverride) {
        await this.originOverride.initPage(this.browser, page);
      }
    }

    if (this.params.logging.includes("jserrors")) {
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          logger.warn(
            msg.text(),
            { location: msg.location(), page: page.url(), workerid },
            "jsError",
          );
        }
      });

      page.on("pageerror", (e) => {
        logger.warn(
          "Page Error",
          { ...formatErr(e), page: page.url(), workerid },
          "jsError",
        );
      });
    }

    if (this.screencaster) {
      logger.debug("Start Screencast", { workerid }, "screencast");
      await this.screencaster.screencastPage(page, cdp, workerid);
    }

    await page.exposeFunction(
      ADD_LINK_FUNC,
      (url: string) => callbacks.addLink && callbacks.addLink(url),
    );

    if (this.params.behaviorOpts) {
      await page.exposeFunction(
        BEHAVIOR_LOG_FUNC,
        (logdata: { data: string; type: string }) =>
          this._behaviorLog(logdata, page.url(), workerid),
      );
      await this.browser.addInitScript(page, behaviors);

      const initScript = `
self.__bx_behaviors.init(${this.params.behaviorOpts}, false);
${this.customBehaviors}
self.__bx_behaviors.selectMainBehavior();
`;
      if (!this.behaviorsChecked && this.customBehaviors) {
        await this.checkBehaviorScripts(cdp);
        this.behaviorsChecked = true;
      }

      await this.browser.addInitScript(page, initScript);
    }
  }

  loadCustomBehaviors(filename: string) {
    let str = "";

    for (const { contents } of collectAllFileSources(filename, ".js")) {
      str += `self.__bx_behaviors.load(${contents});\n`;
    }

    return str;
  }

  async checkBehaviorScripts(cdp: CDPSession) {
    const filename = this.params.customBehaviors;

    if (!filename) {
      return;
    }

    for (const { path, contents } of collectAllFileSources(filename, ".js")) {
      await this.browser.checkScript(cdp, path, contents);
    }
  }

  async getFavicon(page: Page, logDetails: LogDetails): Promise<string> {
    try {
      const resp = await fetch("http://127.0.0.1:9221/json");
      if (resp.status === 200) {
        const browserJson = await resp.json();
        for (const jsons of browserJson) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (jsons.id === (page.target() as any)._targetId) {
            return jsons.faviconUrl;
          }
        }
      }
    } catch (e) {
      // ignore
    }
    logger.warn(
      "Failed to fetch favicon from browser /json endpoint",
      logDetails,
    );
    return "";
  }

  async crawlPage(opts: WorkerState) {
    await this.writeStats();

    const { page, cdp, data, workerid, callbacks, directFetchCapture } = opts;
    data.callbacks = callbacks;

    const { url } = data;

    const logDetails = { page: url, workerid };
    data.logDetails = logDetails;
    data.workerid = workerid;

    data.isHTMLPage = await timedRun(
      this.isHTML(url, logDetails),
      FETCH_TIMEOUT_SECS,
      "HEAD request to determine if URL is HTML page timed out",
      logDetails,
      "fetch",
      true,
    );

    if (!data.isHTMLPage && directFetchCapture) {
      try {
        const { fetched, mime } = await timedRun(
          directFetchCapture(url),
          FETCH_TIMEOUT_SECS,
          "Direct fetch capture attempt timed out",
          logDetails,
          "fetch",
          true,
        );
        if (fetched) {
          data.loadState = LoadState.FULL_PAGE_LOADED;
          if (mime) {
            data.mime = mime;
          }
          data.status = 200;
          logger.info(
            "Direct fetch successful",
            { url, ...logDetails },
            "fetch",
          );
          return true;
        }
      } catch (e) {
        // filtered out direct fetch
        logger.debug(
          "Direct fetch response not accepted, continuing with browser fetch",
          logDetails,
          "fetch",
        );
      }
    }

    // run custom driver here
    await this.driver({ page, data, crawler: this });

    data.title = await page.title();
    data.favicon = await this.getFavicon(page, logDetails);

    const archiveDir = path.join(this.collDir, "archive");

    if (this.params.screenshot) {
      if (!data.isHTMLPage) {
        logger.debug("Skipping screenshots for non-HTML page", logDetails);
      }
      const screenshots = new Screenshots({
        warcPrefix: this.warcPrefix,
        browser: this.browser,
        page,
        url,
        directory: archiveDir,
      });
      if (this.params.screenshot.includes("view")) {
        await screenshots.take();
      }
      if (this.params.screenshot.includes("fullPage")) {
        await screenshots.takeFullPage();
      }
      if (this.params.screenshot.includes("thumbnail")) {
        await screenshots.takeThumbnail();
      }
    }

    let textextract = null;

    if (data.isHTMLPage) {
      textextract = new TextExtractViaSnapshot(cdp, {
        warcPrefix: this.warcPrefix,
        url,
        directory: archiveDir,
      });
      const { changed, text } = await textextract.extractAndStoreText(
        "text",
        false,
        this.params.text.includes("to-warc"),
      );

      if (changed && text && this.params.text.includes("to-pages")) {
        data.text = text;
      }
    }

    data.loadState = LoadState.EXTRACTION_DONE;

    if (data.status >= 400) {
      return;
    }

    if (this.params.behaviorOpts) {
      if (!data.isHTMLPage) {
        logger.debug(
          "Skipping behaviors for non-HTML page",
          logDetails,
          "behavior",
        );
      } else if (data.skipBehaviors) {
        logger.info("Skipping behaviors for slow page", logDetails, "behavior");
      } else {
        const res = await timedRun(
          this.runBehaviors(page, cdp, data.filteredFrames, logDetails),
          this.params.behaviorTimeout,
          "Behaviors timed out",
          logDetails,
          "behavior",
        );

        await this.netIdle(page, logDetails);

        if (res) {
          data.loadState = LoadState.BEHAVIORS_DONE;
        }

        if (textextract && this.params.text.includes("final-to-warc")) {
          await textextract.extractAndStoreText("textFinal", true, true);
        }
      }
    }

    if (this.params.pageExtraDelay) {
      logger.info(
        `Waiting ${this.params.pageExtraDelay} seconds before moving on to next page`,
        logDetails,
      );
      await sleep(this.params.pageExtraDelay);
    }

    return true;
  }

  async pageFinished(data: PageState) {
    await this.writePage(data);

    // if page loaded, considered page finished successfully
    // (even if behaviors timed out)
    const { loadState, logDetails } = data;

    if (data.loadState >= LoadState.FULL_PAGE_LOADED) {
      logger.info("Page Finished", { loadState, ...logDetails }, "pageStatus");

      await this.crawlState.markFinished(data.url);

      if (this.healthChecker) {
        this.healthChecker.resetErrors();
      }
    } else {
      logger.warn(
        "Page Load Failed",
        { loadState, ...logDetails },
        "pageStatus",
      );

      await this.crawlState.markFailed(data.url);

      if (this.healthChecker) {
        this.healthChecker.incError();
      }
    }

    await this.serializeConfig();

    await this.checkLimits();
  }

  async teardownPage({ workerid }: WorkerOpts) {
    if (this.screencaster) {
      await this.screencaster.stopById(workerid);
    }
  }

  async workerIdle(workerid: WorkerId) {
    if (this.screencaster) {
      //logger.debug("End Screencast", {workerid}, "screencast");
      await this.screencaster.stopById(workerid, true);
    }
  }

  async runBehaviors(
    page: Page,
    cdp: CDPSession,
    frames: Frame[],
    logDetails: LogDetails,
  ) {
    try {
      frames = frames || page.frames();

      logger.info(
        "Running behaviors",
        {
          frames: frames.length,
          frameUrls: frames.map((frame) => frame.url()),
          ...logDetails,
        },
        "behavior",
      );

      const results = await Promise.allSettled(
        frames.map((frame) =>
          this.browser.evaluateWithCLI(
            page,
            frame,
            cdp,
            `
          if (!self.__bx_behaviors) {
            console.error("__bx_behaviors missing, can't run behaviors");
          } else {
            self.__bx_behaviors.run();
          }`,
            logDetails,
            "behavior",
          ),
        ),
      );

      for (const res of results) {
        const { status, reason }: { status: string; reason?: string } = res;
        if (status === "rejected") {
          logger.warn(
            "Behavior run partially failed",
            { reason, ...logDetails },
            "behavior",
          );
        }
      }

      logger.info(
        "Behaviors finished",
        { finished: results.length, ...logDetails },
        "behavior",
      );
      return true;
    } catch (e) {
      logger.warn(
        "Behavior run failed",
        { ...formatErr(e), ...logDetails },
        "behavior",
      );
      return false;
    }
  }

  async shouldIncludeFrame(frame: Frame, logDetails: LogDetails) {
    if (!frame.parentFrame()) {
      return frame;
    }

    const frameUrl = frame.url();

    // this is all designed to detect and skip PDFs, and other frames that are actually EMBEDs
    // if there's no tag or an iframe tag, then assume its a regular frame
    const tagName = await frame.evaluate(
      "self && self.frameElement && self.frameElement.tagName",
    );

    if (tagName && tagName !== "IFRAME" && tagName !== "FRAME") {
      logger.debug(
        "Skipping processing non-frame object",
        { tagName, frameUrl, ...logDetails },
        "behavior",
      );
      return null;
    }

    let res;

    if (frameUrl === "about:blank") {
      res = false;
    } else {
      res = this.adBlockRules && !this.adBlockRules.isAdUrl(frameUrl);
    }

    if (!res) {
      logger.debug(
        "Skipping processing frame",
        { frameUrl, ...logDetails },
        "behavior",
      );
    }

    return res ? frame : null;
  }

  async getInfoString() {
    const packageFileJSON = JSON.parse(
      await fsp.readFile(new URL("../package.json", import.meta.url), {
        encoding: "utf-8",
      }),
    );
    const warcioPackageJSON = JSON.parse(
      await fsp.readFile(
        new URL("../node_modules/warcio/package.json", import.meta.url),
        { encoding: "utf-8" },
      ),
    );

    return `Browsertrix-Crawler ${packageFileJSON.version} (with warcio.js ${warcioPackageJSON.version})`;
  }

  async createWARCInfo(filename: string) {
    const warcVersion = "WARC/1.0";
    const type = "warcinfo";

    const info = {
      software: this.infoString,
      format: "WARC File Format 1.0",
    };

    const warcInfo = { ...info, ...this.params.warcInfo };
    const record = await warcio.WARCRecord.createWARCInfo(
      { filename, type, warcVersion },
      warcInfo,
    );
    const buffer = await warcio.WARCSerializer.serialize(record, {
      gzip: true,
    });
    return buffer;
  }

  async checkLimits() {
    let interrupt = false;

    const dir = path.join(this.collDir, "archive");
    const size = await getDirSize(dir);

    await this.crawlState.setArchiveSize(size);

    if (this.params.sizeLimit) {
      if (size >= this.params.sizeLimit) {
        logger.info(
          `Size threshold reached ${size} >= ${this.params.sizeLimit}, stopping`,
        );
        interrupt = true;
      }
    }

    if (this.params.timeLimit) {
      const elapsed = secondsElapsed(this.startTime);
      if (elapsed >= this.params.timeLimit) {
        logger.info(
          `Time threshold reached ${elapsed} > ${this.params.timeLimit}, stopping`,
        );
        interrupt = true;
      }
    }

    if (this.params.diskUtilization) {
      // Check that disk usage isn't already or soon to be above threshold
      const diskUtil = await checkDiskUtilization(this.params, size);
      if (diskUtil.stop === true) {
        interrupt = true;
      }
    }

    if (this.params.failOnFailedLimit) {
      const numFailed = this.crawlState.numFailed();
      if (numFailed >= this.params.failOnFailedLimit) {
        logger.fatal(
          `Failed threshold reached ${numFailed} >= ${this.params.failedLimit}, failing crawl`,
        );
      }
    }

    if (interrupt) {
      this.uploadAndDeleteLocal = true;
      this.gracefulFinishOnInterrupt();
    }
  }

  gracefulFinishOnInterrupt() {
    this.interrupted = true;
    logger.info("Crawler interrupted, gracefully finishing current pages");
    if (!this.params.waitOnDone && !this.params.restartsOnError) {
      this.finalExit = true;
    }
  }

  async checkCanceled() {
    if (this.crawlState && (await this.crawlState.isCrawlCanceled())) {
      await this.setStatusAndExit(0, "canceled");
    }
  }

  async setStatusAndExit(exitCode: number, status: string) {
    logger.info(`Exiting, Crawl status: ${status}`);

    await this.closeLog();

    if (this.crawlState && status) {
      await this.crawlState.setStatus(status);
    }
    process.exit(exitCode);
  }

  async serializeAndExit() {
    await this.serializeConfig();

    if (this.interrupted) {
      await this.setStatusAndExit(13, "interrupted");
    } else {
      await this.setStatusAndExit(0, "done");
    }
  }

  async isCrawlRunning() {
    if (this.interrupted) {
      return false;
    }

    if (await this.crawlState.isCrawlCanceled()) {
      await this.setStatusAndExit(0, "canceled");
      return false;
    }

    if (await this.crawlState.isCrawlStopped()) {
      logger.info("Crawler is stopped");
      return false;
    }

    return true;
  }

  async crawl() {
    if (this.params.healthCheckPort) {
      this.healthChecker = new HealthChecker(
        this.params.healthCheckPort,
        this.params.workers,
      );
    }

    try {
      const driverUrl = new URL(this.params.driver, import.meta.url);
      this.driver = (await import(driverUrl.href)).default;
    } catch (e) {
      logger.warn(`Error importing driver ${this.params.driver}`, e);
      return;
    }

    await this.initCrawlState();

    let initState = await this.crawlState.getStatus();

    while (initState === "debug") {
      logger.info("Paused for debugging, will continue after manual resume");

      await sleep(60);

      initState = await this.crawlState.getStatus();
    }

    // if already done, don't crawl anymore
    if (initState === "done") {
      this.done = true;

      if (this.params.waitOnDone) {
        logger.info("Already done, waiting for signal to exit...");

        // wait forever until signal
        await new Promise(() => {});
      }

      return;
    }

    if (this.params.generateWACZ) {
      this.storage = initStorage();
    }

    if (POST_CRAWL_STATES.includes(initState)) {
      logger.info("crawl already finished, running post-crawl tasks", {
        state: initState,
      });
      await this.postCrawl();
      return;
    } else if (await this.crawlState.isCrawlStopped()) {
      logger.info("crawl stopped, running post-crawl tasks");
      this.finalExit = true;
      await this.postCrawl();
      return;
    } else if (await this.crawlState.isCrawlCanceled()) {
      logger.info("crawl canceled, will exit");
      return;
    }

    await this.crawlState.setStatus("running");

    if (this.params.state) {
      await this.crawlState.load(
        this.params.state,
        this.params.scopedSeeds,
        true,
      );
    }

    await this.initPages();

    this.adBlockRules = new AdBlockRules(
      this.captureBasePrefix,
      this.params.adBlockMessage,
    );

    if (this.params.blockRules && this.params.blockRules.length) {
      this.blockRules = new BlockRules(
        this.params.blockRules,
        this.captureBasePrefix,
        this.params.blockMessage,
      );
    }

    this.screencaster = this.initScreenCaster();

    if (this.params.originOverride.length) {
      this.originOverride = new OriginOverride(this.params.originOverride);
    }

    for (let i = 0; i < this.params.scopedSeeds.length; i++) {
      const seed = this.params.scopedSeeds[i];
      if (!(await this.queueUrl(i, seed.url, 0, 0))) {
        if (this.limitHit) {
          break;
        }
      }

      if (seed.sitemap) {
        await this.parseSitemap(seed.sitemap, i, this.params.sitemapFromDate);
      }
    }

    await this.browser.launch({
      profileUrl: this.params.profile,
      headless: this.params.headless,
      emulateDevice: this.emulateDevice,
      chromeOptions: {
        proxy: false,
        userAgent: this.emulateDevice.userAgent,
        extraArgs: this.extraChromeArgs(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ondisconnect: (err: any) => {
        this.interrupted = true;
        logger.error(
          "Browser disconnected (crashed?), interrupting crawl",
          err,
          "browser",
        );
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // --------------
    // Run Crawl Here!
    await runWorkers(this, this.params.workers, this.maxPageTime, this.collDir);
    // --------------

    await this.serializeConfig(true);

    if (this.pagesFH) {
      await this.pagesFH.sync();
      await this.pagesFH.close();
    }

    await this.writeStats();

    // if crawl has been stopped, mark as final exit for post-crawl tasks
    if (await this.crawlState.isCrawlStopped()) {
      this.finalExit = true;
    }

    await this.postCrawl();
  }

  async postCrawl() {
    if (this.params.combineWARC) {
      await this.combineWARC();
    }

    if (this.params.generateCDX) {
      logger.info("Generating CDX");
      await fsp.mkdir(path.join(this.collDir, "indexes"), { recursive: true });
      await this.crawlState.setStatus("generate-cdx");

      const warcList = await fsp.readdir(path.join(this.collDir, "archive"));
      const warcListFull = warcList.map((filename) =>
        path.join(this.collDir, "archive", filename),
      );

      //const indexResult = await this.awaitProcess(child_process.spawn("wb-manager", ["reindex", this.params.collection], {cwd: this.params.cwd}));
      const params = [
        "-o",
        path.join(this.collDir, "indexes", "index.cdxj"),
        ...warcListFull,
      ];
      const indexResult = await this.awaitProcess(
        child_process.spawn("cdxj-indexer", params, { cwd: this.params.cwd }),
      );
      if (indexResult === 0) {
        logger.debug("Indexing complete, CDX successfully created");
      } else {
        logger.error("Error indexing and generating CDX", {
          "status code": indexResult,
        });
      }
    }

    logger.info("Crawling done");

    if (
      this.params.generateWACZ &&
      (!this.interrupted || this.finalExit || this.uploadAndDeleteLocal)
    ) {
      const uploaded = await this.generateWACZ();

      if (uploaded && this.uploadAndDeleteLocal) {
        logger.info(
          `Uploaded WACZ, deleting local data to free up space: ${this.collDir}`,
        );
        try {
          fs.rmSync(this.collDir, { recursive: true, force: true });
        } catch (e) {
          logger.warn(`Unable to clear ${this.collDir} before exit`, e);
        }
      }
    }

    if (this.params.waitOnDone && (!this.interrupted || this.finalExit)) {
      this.done = true;
      logger.info("All done, waiting for signal...");
      await this.crawlState.setStatus("done");

      // wait forever until signal
      await new Promise(() => {});
    }
  }

  async closeLog(): Promise<void> {
    // close file-based log
    logger.setExternalLogStream(null);
    if (!this.logFH) {
      return;
    }
    try {
      await new Promise<void>((resolve) => this.logFH.close(() => resolve()));
    } catch (e) {
      // ignore
    }
  }

  async generateWACZ() {
    logger.info("Generating WACZ");
    await this.crawlState.setStatus("generate-wacz");

    const archiveDir = path.join(this.collDir, "archive");

    // Get a list of the warcs inside
    const warcFileList = await fsp.readdir(archiveDir);

    // is finished (>0 pages and all pages written)
    const isFinished = await this.crawlState.isFinished();

    logger.info(`Num WARC Files: ${warcFileList.length}`);
    if (!warcFileList.length) {
      // if finished, just return
      if (isFinished || (await this.crawlState.isCrawlCanceled())) {
        return;
      }
      // if stopped, won't get anymore data
      if (await this.crawlState.isCrawlStopped()) {
        // possibly restarted after committing, so assume done here!
        if ((await this.crawlState.numDone()) > 0) {
          return;
        }
      }
      // fail crawl otherwise
      logger.fatal("No WARC Files, assuming crawl failed");
    }

    logger.debug("End of log file, storing logs in WACZ");

    // Build the argument list to pass to the wacz create command
    const waczFilename = this.params.collection.concat(".wacz");
    const waczPath = path.join(this.collDir, waczFilename);

    const createArgs = [
      "create",
      "--split-seeds",
      "-o",
      waczPath,
      "--pages",
      this.pagesFile,
      "--log-directory",
      this.logDir,
    ];

    if (process.env.WACZ_SIGN_URL) {
      createArgs.push("--signing-url");
      createArgs.push(process.env.WACZ_SIGN_URL);
      if (process.env.WACZ_SIGN_TOKEN) {
        createArgs.push("--signing-token");
        createArgs.push(process.env.WACZ_SIGN_TOKEN);
      }
    }

    if (this.params.title) {
      createArgs.push("--title");
      createArgs.push(this.params.title);
    }

    if (this.params.description) {
      createArgs.push("--desc");
      createArgs.push(this.params.description);
    }

    createArgs.push("-f");

    warcFileList.forEach((val) => createArgs.push(path.join(archiveDir, val)));

    // create WACZ
    const waczResult = await this.awaitProcess(
      child_process.spawn("wacz", createArgs),
    );

    if (waczResult !== 0) {
      logger.error("Error creating WACZ", { "status code": waczResult });
      logger.fatal("Unable to write WACZ successfully");
    }

    logger.debug(`WACZ successfully generated and saved to: ${waczPath}`);

    // Verify WACZ
    /*
    const validateArgs = ["validate"];
    validateArgs.push("-f");
    validateArgs.push(waczPath);

    const waczVerifyResult = await this.awaitProcess(child_process.spawn("wacz", validateArgs));

    if (waczVerifyResult !== 0) {
      console.log("validate", waczVerifyResult);
      logger.fatal("Unable to verify WACZ created successfully");
    }
*/
    if (this.storage) {
      await this.crawlState.setStatus("uploading-wacz");
      const filename = process.env.STORE_FILENAME || "@ts-@id.wacz";
      const targetFilename = interpolateFilename(filename, this.crawlId);

      await this.storage.uploadCollWACZ(waczPath, targetFilename, isFinished);
      return true;
    }

    return false;
  }

  awaitProcess(proc: ChildProcess) {
    const stdout: string[] = [];
    const stderr: string[] = [];

    proc.stdout!.on("data", (data) => {
      stdout.push(data.toString());
    });

    proc.stderr!.on("data", (data) => {
      stderr.push(data.toString());
    });

    return new Promise((resolve) => {
      proc.on("close", (code) => {
        if (stdout.length) {
          logger.debug(stdout.join("\n"));
        }
        if (stderr.length && this.params.logging.includes("debug")) {
          logger.debug(stderr.join("\n"));
        }
        resolve(code);
      });
    });
  }

  logMemory() {
    const memUsage = process.memoryUsage();
    const { heapUsed, heapTotal } = memUsage;
    this.maxHeapUsed = Math.max(this.maxHeapUsed || 0, heapUsed);
    this.maxHeapTotal = Math.max(this.maxHeapTotal || 0, heapTotal);
    logger.debug(
      "Memory",
      {
        maxHeapUsed: this.maxHeapUsed,
        maxHeapTotal: this.maxHeapTotal,
        ...memUsage,
      },
      "memoryStatus",
    );
  }

  async writeStats() {
    if (!this.params.logging.includes("stats")) {
      return;
    }

    const realSize = await this.crawlState.queueSize();
    const pendingList = await this.crawlState.getPendingList();
    const done = await this.crawlState.numDone();
    const failed = await this.crawlState.numFailed();
    const total = realSize + pendingList.length + done;
    const limit = { max: this.pageLimit || 0, hit: this.limitHit };
    const stats = {
      crawled: done,
      total: total,
      pending: pendingList.length,
      failed: failed,
      limit: limit,
      pendingPages: pendingList.map((x) => JSON.stringify(x)),
    };

    logger.info("Crawl statistics", stats, "crawlStatus");
    this.logMemory();

    if (this.params.statsFilename) {
      try {
        await fsp.writeFile(
          this.params.statsFilename,
          JSON.stringify(stats, null, 2),
        );
      } catch (err) {
        logger.warn("Stats output failed", err);
      }
    }
  }

  async loadPage(
    page: Page,
    data: PageState,
    selectorOptsList = DEFAULT_SELECTORS,
  ) {
    const { url, depth } = data;

    const logDetails = data.logDetails;

    const failCrawlOnError = depth === 0 && this.params.failOnFailedSeed;

    let ignoreAbort = false;

    // Detect if ERR_ABORTED is actually caused by trying to load a non-page (eg. downloadable PDF),
    // if so, don't report as an error
    page.once("requestfailed", (req: HTTPRequest) => {
      ignoreAbort = shouldIgnoreAbort(req);
    });

    let isHTMLPage = data.isHTMLPage;

    if (isHTMLPage) {
      page.once("domcontentloaded", () => {
        data.loadState = LoadState.CONTENT_LOADED;
      });
    }

    const gotoOpts = isHTMLPage
      ? this.gotoOpts
      : { waitUntil: "domcontentloaded" };

    logger.info("Awaiting page load", logDetails);

    try {
      const resp = await page.goto(url, gotoOpts);

      if (!resp) {
        throw new Error("page response missing");
      }

      const respUrl = resp.url();
      const isChromeError = page.url().startsWith("chrome-error://");

      if (depth === 0 && !isChromeError && respUrl !== url) {
        const seed = this.params.scopedSeeds[data.seedId];
        this.params.scopedSeeds.push(seed.newScopedSeed(respUrl));
        data.seedId = this.params.scopedSeeds.length - 1;
        logger.info("Seed page redirected, adding redirected seed", {
          origUrl: url,
          newUrl: respUrl,
          seedId: data.seedId,
        });
      }

      const status = resp.status();
      data.status = status;

      let failed = isChromeError;

      if (this.params.failOnInvalidStatus && status >= 400) {
        // Handle 4xx or 5xx response as a page load error
        failed = true;
      }

      if (failed) {
        if (failCrawlOnError) {
          logger.fatal("Seed Page Load Error, failing crawl", {
            status,
            ...logDetails,
          });
        } else {
          logger.error(
            isChromeError ? "Page Crashed on Load" : "Page Invalid Status",
            {
              status,
              ...logDetails,
            },
          );
          throw new Error("logged");
        }
      }

      const contentType = resp.headers()["content-type"];

      isHTMLPage = this.isHTMLContentType(contentType);
    } catch (e) {
      if (!(e instanceof Error)) {
        throw e;
      }
      const msg = e.message || "";
      if (!msg.startsWith("net::ERR_ABORTED") || !ignoreAbort) {
        // if timeout error, and at least got to content loaded, continue on
        if (
          e.name === "TimeoutError" &&
          data.loadState == LoadState.CONTENT_LOADED
        ) {
          logger.warn("Page Loading Slowly, skipping behaviors", {
            msg,
            ...logDetails,
          });
          data.skipBehaviors = true;
        } else if (failCrawlOnError) {
          // if fail on error, immediately fail here
          logger.fatal("Page Load Timeout, failing crawl", {
            msg,
            ...logDetails,
          });
        } else {
          // log if not already log and rethrow
          if (msg !== "logged") {
            logger.error("Page Load Timeout, skipping page", {
              msg,
              ...logDetails,
            });
            e.message = "logged";
          }
          throw e;
        }
      }
    }

    data.loadState = LoadState.FULL_PAGE_LOADED;

    data.isHTMLPage = isHTMLPage;

    if (isHTMLPage) {
      const frames = await page.frames();

      const filteredFrames = await Promise.allSettled(
        frames.map((frame) => this.shouldIncludeFrame(frame, logDetails)),
      );

      data.filteredFrames = filteredFrames
        .filter((x: PromiseSettledResult<Frame | null>) => {
          if (x.status === "fulfilled") {
            return !!x.value;
          }
          logger.warn("Error in iframe check", {
            reason: x.reason,
            ...logDetails,
          });
          return false;
        })
        .map((x) => (x as PromiseFulfilledResult<Frame>).value);

      //data.filteredFrames = await page.frames().filter(frame => this.shouldIncludeFrame(frame, logDetails));
    } else {
      data.filteredFrames = [];
    }

    if (!isHTMLPage) {
      logger.debug("Skipping link extraction for non-HTML page", logDetails);
      return;
    }

    const { seedId } = data;

    const seed = this.params.scopedSeeds[seedId];

    await this.checkCF(page, logDetails);

    await this.netIdle(page, logDetails);

    // skip extraction if at max depth
    if (seed.isAtMaxDepth(depth) || !selectorOptsList) {
      logger.debug("Skipping Link Extraction, At Max Depth");
      return;
    }

    logger.debug("Extracting links", logDetails);

    await this.extractLinks(page, data, selectorOptsList, logDetails);
  }

  async netIdle(page: Page, details: LogDetails) {
    if (!this.params.netIdleWait) {
      return;
    }
    // in case page starts loading via fetch/xhr immediately after page load,
    // we want to ensure we don't exit too early
    await sleep(0.5);

    try {
      await this.browser.waitForNetworkIdle(page, {
        timeout: this.params.netIdleWait * 1000,
      });
    } catch (e) {
      logger.debug("waitForNetworkIdle timed out, ignoring", details);
      // ignore, continue
    }
  }

  async extractLinks(
    page: Page,
    data: PageState,
    selectors = DEFAULT_SELECTORS,
    logDetails: LogDetails,
  ) {
    const { seedId, depth, extraHops = 0, filteredFrames, callbacks } = data;

    callbacks.addLink = async (url: string) => {
      await this.queueInScopeUrls(seedId, [url], depth, extraHops, logDetails);
    };

    const loadLinks = (options: {
      selector: string;
      extract: string;
      isAttribute: boolean;
      addLinkFunc: string;
    }) => {
      const { selector, extract, isAttribute, addLinkFunc } = options;
      const urls = new Set<string>();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getAttr = (elem: any) => urls.add(elem.getAttribute(extract));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getProp = (elem: any) => urls.add(elem[extract]);

      const getter = isAttribute ? getAttr : getProp;

      document.querySelectorAll(selector).forEach(getter);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const func = (window as any)[addLinkFunc] as (
        url: string,
      ) => NonNullable<unknown>;
      urls.forEach((url) => func.call(this, url));

      return true;
    };

    const frames = filteredFrames || page.frames();

    try {
      for (const {
        selector = "a[href]",
        extract = "href",
        isAttribute = false,
      } of selectors) {
        const promiseResults = await Promise.allSettled(
          frames.map((frame) =>
            timedRun(
              frame.evaluate(loadLinks, {
                selector,
                extract,
                isAttribute,
                addLinkFunc: ADD_LINK_FUNC,
              }),
              PAGE_OP_TIMEOUT_SECS,
              "Link extraction timed out",
              logDetails,
            ),
          ),
        );

        for (let i = 0; i < promiseResults.length; i++) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { status, reason } = promiseResults[i] as any;
          if (status === "rejected") {
            logger.warn("Link Extraction failed in frame", {
              reason,
              frameUrl: frames[i].url,
              ...logDetails,
            });
          }
        }
      }
    } catch (e) {
      logger.warn("Link Extraction failed", e, "links");
    }
  }

  async queueInScopeUrls(
    seedId: number,
    urls: string[],
    depth: number,
    extraHops = 0,
    logDetails: LogDetails = {},
  ) {
    try {
      depth += 1;

      // new number of extra hops, set if this hop is out-of-scope (oos)
      const newExtraHops = extraHops + 1;

      for (const possibleUrl of urls) {
        const res = this.isInScope(
          { url: possibleUrl, extraHops: newExtraHops, depth, seedId },
          logDetails,
        );

        if (!res) {
          continue;
        }

        const { url, isOOS } = res;

        if (url) {
          await this.queueUrl(
            seedId,
            url,
            depth,
            isOOS ? newExtraHops : extraHops,
            logDetails,
          );
        }
      }
    } catch (e) {
      logger.error("Queuing Error", e, "links");
    }
  }

  async checkCF(page: Page, logDetails: LogDetails) {
    try {
      logger.debug("Check CF Blocking", logDetails);

      while (
        await timedRun(
          page.$("div.cf-browser-verification.cf-im-under-attack"),
          PAGE_OP_TIMEOUT_SECS,
          "Cloudflare check timed out",
          logDetails,
          "general",
          true,
        )
      ) {
        logger.debug(
          "Cloudflare Check Detected, waiting for reload...",
          logDetails,
        );
        await sleep(5.5);
      }
    } catch (e) {
      //logger.warn("Check CF failed, ignoring");
    }
  }

  async queueUrl(
    seedId: number,
    url: string,
    depth: number,
    extraHops: number,
    logDetails: LogDetails = {},
  ) {
    if (this.limitHit) {
      return false;
    }

    const result = await this.crawlState.addToQueue(
      { url, seedId, depth, extraHops },
      this.pageLimit,
    );

    switch (result) {
      case QueueState.ADDED:
        logger.debug("Queued new page url", { url, ...logDetails }, "links");
        return true;

      case QueueState.LIMIT_HIT:
        logger.debug(
          "Not queued page url, at page limit",
          { url, ...logDetails },
          "links",
        );
        this.limitHit = true;
        return false;

      case QueueState.DUPE_URL:
        logger.debug(
          "Not queued page url, already seen",
          { url, ...logDetails },
          "links",
        );
        return false;
    }

    return false;
  }

  async initPages() {
    try {
      let createNew = false;

      // create pages dir if doesn't exist and write pages.jsonl header
      if (fs.existsSync(this.pagesDir) != true) {
        await fsp.mkdir(this.pagesDir);
        createNew = true;
      }

      this.pagesFH = await fsp.open(this.pagesFile, "a");

      if (createNew) {
        const header: Record<string, string> = {
          format: "json-pages-1.0",
          id: "pages",
          title: "All Pages",
        };
        header["hasText"] = this.params.text.includes("to-pages");
        if (this.params.text.length) {
          logger.debug("Text Extraction: " + this.params.text.join(","));
        } else {
          logger.debug("Text Extraction: None");
        }
        const header_formatted = JSON.stringify(header).concat("\n");
        await this.pagesFH.writeFile(header_formatted);
      }
    } catch (err) {
      logger.error("pages/pages.jsonl creation failed", err);
    }
  }

  async writePage({
    pageid,
    url,
    depth,
    title,
    text,
    loadState,
    mime,
    favicon,
    ts,
    status,
  }: PageState) {
    const row: PageEntry = { id: pageid!, url, title, loadState };

    if (ts) {
      row.ts = ts.toISOString();
    }

    if (mime) {
      row.mime = mime;
    }

    if (status) {
      row.status = status;
    }

    if (this.params.writePagesToRedis) {
      await this.crawlState.writeToPagesQueue(JSON.stringify(row));
    }

    if (depth === 0) {
      row.seed = true;
    }

    if (text !== null) {
      row.text = text;
    }

    if (favicon !== null) {
      row.favIconUrl = favicon;
    }

    const processedRow = JSON.stringify(row) + "\n";
    try {
      await this.pagesFH!.writeFile(processedRow);
    } catch (err) {
      logger.warn("pages/pages.jsonl append failed", err);
    }
  }

  resolveAgent(urlParsed: URL) {
    return urlParsed.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT;
  }

  async isHTML(url: string, logDetails: LogDetails) {
    try {
      const resp = await fetch(url, {
        method: "HEAD",
        headers: this.headers,
        agent: this.resolveAgent,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      if (resp.status !== 200) {
        logger.debug("HEAD response code != 200, loading in browser", {
          status: resp.status,
          ...logDetails,
        });
        return true;
      }

      return this.isHTMLContentType(resp.headers.get("Content-Type"));
    } catch (e) {
      // can't confirm not html, so try in browser
      logger.debug("HEAD request failed", { ...formatErr(e), ...logDetails });
      return true;
    }
  }

  isHTMLContentType(contentType: string | null) {
    // just load if no content-type
    if (!contentType) {
      return true;
    }

    const mime = contentType.split(";")[0];

    if (HTML_TYPES.includes(mime)) {
      return true;
    }

    return false;
  }

  async parseSitemap(url: string, seedId: number, sitemapFromDate: number) {
    // handle sitemap last modified date if passed
    let lastmodFromTimestamp = undefined;
    const dateObj = new Date(sitemapFromDate);
    if (isNaN(dateObj.getTime())) {
      logger.info(
        "Fetching full sitemap (fromDate not specified/valid)",
        { url, sitemapFromDate },
        "sitemap",
      );
    } else {
      lastmodFromTimestamp = dateObj.getTime();
      logger.info(
        "Fetching and filtering sitemap by date",
        { url, sitemapFromDate },
        "sitemap",
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sitemapper = new (Sitemapper as any)({
      url,
      timeout: 15000,
      requestHeaders: this.headers,
      lastmod: lastmodFromTimestamp,
    });

    try {
      const { sites } = await sitemapper.fetch();
      logger.info("Sitemap Urls Found", { urls: sites.length }, "sitemap");
      await this.queueInScopeUrls(seedId, sites, 0);
    } catch (e) {
      logger.warn("Error fetching sites from sitemap", e, "sitemap");
    }
  }

  async combineWARC() {
    logger.info("Generating Combined WARCs");
    await this.crawlState.setStatus("generate-warc");

    // Get the list of created Warcs
    const warcLists = await fsp.readdir(path.join(this.collDir, "archive"));

    logger.debug(`Combining ${warcLists.length} WARCs...`);

    const fileSizeObjects = []; // Used to sort the created warc by fileSize

    // Go through a list of the created works and create an array sorted by their filesize with the largest file first.
    for (let i = 0; i < warcLists.length; i++) {
      const fileName = path.join(this.collDir, "archive", warcLists[i]);
      const fileSize = await getFileSize(fileName);
      fileSizeObjects.push({ fileSize: fileSize, fileName: fileName });
      fileSizeObjects.sort((a, b) => b.fileSize - a.fileSize);
    }

    const generatedCombinedWarcs = [];

    // Used to name combined warcs, default to -1 for first increment
    let combinedWarcNumber = -1;

    // write combine WARC to collection root
    let combinedWarcFullPath = "";

    // fileHandler
    let fh = null;

    // Iterate through the sorted file size array.
    for (let j = 0; j < fileSizeObjects.length; j++) {
      // if need to rollover to new warc
      let doRollover = false;

      // set to true for first warc
      if (combinedWarcNumber < 0) {
        doRollover = true;
      } else {
        // Check the size of the existing combined warc.
        const currentCombinedWarcSize = await getFileSize(combinedWarcFullPath);

        //  If adding the current warc to the existing combined file creates a file smaller than the rollover size add the data to the combinedWarc
        const proposedWarcSize =
          fileSizeObjects[j].fileSize + currentCombinedWarcSize;

        doRollover = proposedWarcSize >= this.params.rolloverSize;
      }

      if (doRollover) {
        // If adding the current warc to the existing combined file creates a file larger than the rollover size do the following:
        // 1. increment the combinedWarcNumber
        // 2. create the name of the new combinedWarcFile
        // 3. Write the header out to the new file
        // 4. Write out the current warc data to the combinedFile
        combinedWarcNumber = combinedWarcNumber + 1;

        const combinedWarcName = `${this.params.collection}_${combinedWarcNumber}.warc.gz`;

        // write combined warcs to root collection dir as they're output of a collection (like wacz)
        combinedWarcFullPath = path.join(this.collDir, combinedWarcName);

        if (fh) {
          fh.end();
        }

        fh = fs.createWriteStream(combinedWarcFullPath, { flags: "a" });

        generatedCombinedWarcs.push(combinedWarcName);

        const warcBuffer = await this.createWARCInfo(combinedWarcName);
        fh.write(warcBuffer);
      }

      logger.debug(`Appending WARC ${fileSizeObjects[j].fileName}`);

      const reader = fs.createReadStream(fileSizeObjects[j].fileName);

      const p = new Promise<void>((resolve) => {
        reader.on("end", () => resolve());
      });

      if (fh) {
        reader.pipe(fh, { end: false });
      }

      await p;
    }

    if (fh) {
      await fh.end();
    }

    logger.debug(`Combined WARCs saved as: ${generatedCombinedWarcs}`);
  }

  async serializeConfig(done = false) {
    switch (this.params.saveState) {
      case "never":
        return;

      case "partial":
        if (!done) {
          return;
        }
        if (await this.crawlState.isFinished()) {
          return;
        }
        break;

      case "always":
      default:
        break;
    }

    const now = new Date();

    if (!done) {
      // if not done, save state only after specified interval has elapsed
      if (
        secondsElapsed(this.lastSaveTime, now) < this.params.saveStateInterval
      ) {
        return;
      }
    }

    this.lastSaveTime = now.getTime();

    const ts = now.toISOString().slice(0, 19).replace(/[T:-]/g, "");

    const crawlDir = path.join(this.collDir, "crawls");

    await fsp.mkdir(crawlDir, { recursive: true });

    const filenameOnly = `crawl-${ts}-${this.params.crawlId}.yaml`;

    const filename = path.join(crawlDir, filenameOnly);

    const state = await this.crawlState.serialize();

    if (this.origConfig) {
      this.origConfig.state = state;
    }
    const res = yaml.dump(this.origConfig, { lineWidth: -1 });
    try {
      logger.info(`Saving crawl state to: ${filename}`);
      await fsp.writeFile(filename, res);
    } catch (e) {
      logger.error(`Failed to write save state file: ${filename}`, e);
      return;
    }

    this.saveStateFiles.push(filename);

    if (this.saveStateFiles.length > this.params.saveStateHistory) {
      const oldFilename = this.saveStateFiles.shift();
      logger.info(`Removing old save-state: ${oldFilename}`);
      try {
        await fsp.unlink(oldFilename || "");
      } catch (e) {
        logger.error(`Failed to delete old save state file: ${oldFilename}`);
      }
    }

    if (this.storage && done && this.params.saveState === "always") {
      const targetFilename = interpolateFilename(filenameOnly, this.crawlId);

      await this.storage.uploadFile(filename, targetFilename);
    }
  }
}

function shouldIgnoreAbort(req: HTTPRequest) {
  try {
    const failure = req.failure();
    const failureText = (failure && failure.errorText) || "";
    if (
      failureText !== "net::ERR_ABORTED" ||
      req.resourceType() !== "document"
    ) {
      return false;
    }

    const resp = req.response();
    const headers = resp && resp.headers();

    if (!headers) {
      return false;
    }

    if (
      headers["content-disposition"] ||
      (headers["content-type"] && !headers["content-type"].startsWith("text/"))
    ) {
      return true;
    }
  } catch (e) {
    return false;
  }

  return false;
}
