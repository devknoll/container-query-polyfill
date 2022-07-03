/**
 * Copyright 2022 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {eachLimit} from 'async';
import {readFile} from 'fs/promises';
import {Agent} from 'http';
import {Builder, By, until} from 'selenium-webdriver';
import {Local} from 'browserstack-local';

type Capabilities = Record<string, unknown>;

type BrowserVersion<T> = {
  name: string;
  data: T;
};

type BrowserDefinition<T> = {
  name: string;
  versions: BrowserVersion<T>[];
};

const CHROME_DEFINITION: BrowserDefinition<Capabilities> = {
  name: 'Chrome',
  versions: [],
};

const SAFARI_IOS_DEFINITION: BrowserDefinition<Capabilities> = {
  name: 'Safari (iOS)',
  versions: [
    {
      name: '13.4',
      data: {
        'bstack:options': {
          osVersion: '14',
          deviceName: 'iPad 8th',
          realMobile: true,
        },
        browserName: 'safari',
      },
    },
  ],
};

const SAFARI_MACOS_DEFINITION: BrowserDefinition<Capabilities> = {
  name: 'Safari (macOS)',
  versions: [],
};

const EDGE_DEFINITION: BrowserDefinition<Capabilities> = {
  name: 'Edge',
  versions: [],
};

const FIREFOX_DEFINITION: BrowserDefinition<Capabilities> = {
  name: 'Firefox',
  versions: [],
};

const SAMSUNG_INTERNET_DEFINITION: BrowserDefinition<Capabilities> = {
  name: 'Samsung Internet',
  versions: [],
};

const IE_DEFINITION: BrowserDefinition<Capabilities> = {
  name: 'IE',
  versions: [],
};

const BROWSERS: BrowserDefinition<Capabilities>[] = [
  CHROME_DEFINITION,
  SAFARI_IOS_DEFINITION,
  SAFARI_MACOS_DEFINITION,
  EDGE_DEFINITION,
  FIREFOX_DEFINITION,
  SAMSUNG_INTERNET_DEFINITION,
  IE_DEFINITION,
];

type TestSuite = {
  js: string[];
};
type TestResult = Array<
  [
    string,
    {
      status: number;
    }
  ]
>;

function createLocalServer(): Promise<Local> {
  return new Promise((resolve, reject) => {
    const server = new Local();
    server.start(
      {
        key: process.env.BROWSERSTACK_ACCESS_KEY,
      },
      err => {
        if (err) {
          reject(err);
        } else {
          resolve(server);
        }
      }
    );
  });
}

function stopLocalServer(server: Local): Promise<void> {
  return new Promise(resolve => {
    server.stop(resolve);
  });
}

async function getTests(manifestPath: string): Promise<TestSuite> {
  const manifestBuffer = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBuffer.toString());

  const prefix = `css/css-contain/container-queries`;
  const htmlTests =
    manifest.items.testharness.css['css-contain']['container-queries'];

  return {
    js: Object.keys(htmlTests).map(
      name => `http://web-platform.test:8000/${prefix}/${name}`
    ),
  };
}

function createWebDriver(capabilities: Record<string, unknown>) {
  return new Builder()
    .usingHttpAgent(
      new Agent({
        keepAlive: true,
        keepAliveMsecs: 30 * 1000,
      })
    )
    .usingServer('http://hub-cloud.browserstack.com/wd/hub')
    .withCapabilities({
      ...capabilities,
      'bstack:options': {
        ...(capabilities as any)['bstack:options'],
        userName: process.env.BROWSERSTACK_USERNAME,
        accessKey: process.env.BROWSERSTACK_ACCESS_KEY,
        local: true,
        debug: true,
        consoleLogs: 'verbose',
        networkLogs: true,
        seleniumVersion: '4.1.0',
      },
    })
    .build();
}

async function runTestSuite(
  name: string,
  capabilities: Record<string, unknown>,
  testSuite: TestSuite
): Promise<TestResult> {
  const driver = createWebDriver(capabilities);

  try {
    console.info(`[${name}] Connecting...`);
    await driver.get('http://bs-local.com:9606/tests/runner.html');

    console.info(`[${name}] Running tests...`);
    await driver.executeScript(
      `window.RUN_CQ_TESTS(${JSON.stringify(testSuite)})`
    );

    const resultsElem = await driver.wait(
      until.elementLocated(By.id('__test_results__')),
      3 * 60 * 1000,
      'Timed out',
      5 * 1000
    );
    return JSON.parse(await resultsElem.getAttribute('innerHTML'));
  } catch (err) {
    console.warn(`[${name}] Failed: ${err}`);
    throw err;
  } finally {
    await driver.quit();
  }
}

async function main() {
  const manifestPath = process.env.WPT_MANIFEST;
  if (!manifestPath) {
    throw new Error('invariant: WPT_MANIFEST environment variable must be set');
  }

  const testSuite = await getTests(manifestPath);
  const tests: Array<() => Promise<void>> = [];
  const results: BrowserDefinition<TestResult>[] = BROWSERS.map(browser => ({
    ...browser,
    versions: browser.versions.map(version => {
      const result: BrowserVersion<TestResult> = {
        ...version,
        data: [],
      };
      tests.push(async () => {
        result.data = await runTestSuite(
          `${browser.name} ${version.name}`,
          version.data,
          testSuite
        );
      });
      return result;
    }),
  }));

  const server = await createLocalServer();
  try {
    await eachLimit(tests, 5, test => test());
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await stopLocalServer(server);
  }
}

await main();
