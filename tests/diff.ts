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

import {readFile} from 'fs/promises';
import {dirname, join} from 'path';
import {fileURLToPath} from 'url';

interface TestMap<T> {
  [key: string]: SubtestMap<T> | undefined;
}

interface SubtestMap<T> {
  [key: string]: T | undefined;
}

interface BrowserResults {
  passed: string[];
  failed: string[];
}

interface Diff<T> {
  before?: T;
  after?: T;
}

function getTargetForDescriptor<T>(
  testMap: TestMap<T>,
  descriptor: TestDescriptor,
  defaultValue: () => T
) {
  const testToSubtest = (testMap[descriptor.test] =
    testMap[descriptor.test] || {});
  const subtestToTarget = (testToSubtest[descriptor.subtest] =
    testToSubtest[descriptor.subtest] || defaultValue());

  testMap[descriptor.test] = testToSubtest;
  testToSubtest[descriptor.subtest] = subtestToTarget;

  return subtestToTarget;
}

const newTestMap: TestMap<BrowserResults> = {};
for (const browser of results) {
  for (const version of browser.versions) {
    if (version.data.type === DataType.Result) {
      const [passed, failed] = version.data.result;
      const name = `${browser.name} ${version.name}`;

      for (const result of passed) {
        const target = getTargetForDescriptor(newTestMap, result, () => ({
          passed: [],
          failed: [],
        }));
        target.passed.push(name);
      }

      for (const result of failed) {
        const target = getTargetForDescriptor(newTestMap, result, () => ({
          passed: [],
          failed: [],
        }));
        target.failed.push(name);
      }
    }
  }
}

const baselineBuffer = await readFile(
  join(dirname(fileURLToPath(import.meta.url)), 'baseline.json')
);
const baselineTestMap: TestMap<BrowserResults> = JSON.parse(
  baselineBuffer.toString('utf-8')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) as any;

const deltaTestMap: TestMap<Diff<BrowserResults>> = {};
const allTestNames = new Set(
  [...Object.keys(baselineTestMap), ...Object.keys(newTestMap)].sort()
);

for (const test in allTestNames) {
  const newSubtests = newTestMap[test] ?? {};
  const baselineSubtests = baselineTestMap[test] ?? {};
  const allSubtestNames = new Set(
    [...Object.keys(newSubtests), ...Object.keys(baselineSubtests)].sort()
  );

  for (const subtest in allSubtestNames) {
    const target = getTargetForDescriptor<Diff<BrowserResults>>(
      deltaTestMap,
      {test, subtest},
      () => ({})
    );
    target.before = baselineSubtests[subtest];
    target.after = newSubtests[subtest];
  }
}

console.info(JSON.stringify(deltaTestMap, null, 2));
