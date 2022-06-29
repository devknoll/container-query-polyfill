/**
 * Copyright 2021 Google Inc. All Rights Reserved.
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

import {
  parseStylesheet,
  serialize,
  tokenize,
  AtRuleNode,
  QualifiedRuleNode,
  Type,
  Node,
  createNodeParser,
  NumberFlag,
  DeclarationNode,
  parseDeclaration,
  BlockType,
  RuleListBlock,
  serializeBlock,
  DimensionToken,
} from './utils/css.js';
import {
  ContainerType,
  evaluateContainerCondition,
  ExpressionNode,
  QueryContext,
  WritingMode,
} from './evaluate.js';
import {
  parseContainerNameProperty,
  parseContainerRule,
  parseContainerShorthand,
  parseContainerTypeProperty,
} from './parser.js';
import {
  GenericExpressionNode,
  GenericExpressionType,
  parseMediaCondition,
  transformMediaConditionToTokens,
} from './utils/parse-media-query.js';

interface ContainerQueryDescriptor {
  names: Set<string>;
  condition: ExpressionNode;
  uid: string;
  selector: string;
}

interface ContainerState {
  update(contentRect: DOMRectReadOnly): void;
  setParentResults(
    results: Map<ContainerQueryDescriptor, boolean> | null
  ): void;
  dispose(): void;
}

let CONTAINER_ID = 0;

const ELEMENT_TO_CONTAINER: Map<Element, ContainerState> = new Map();
const CONTAINER_QUERIES: Set<ContainerQueryDescriptor> = new Set();

const PER_RUN_UID = generateUID();
const CUSTOM_PROPERTY_SHORTHAND = `--cq-container-${PER_RUN_UID}`;
const CUSTOM_PROPERTY_TYPE = `--cq-container-type-${PER_RUN_UID}`;
const CUSTOM_PROPERTY_NAME = `--cq-container-name-${PER_RUN_UID}`;
const CUSTOM_PROPERTY_SVH = `--cq-svh-${PER_RUN_UID}`;
const CUSTOM_PROPERTY_SVW = `--cq-svw-${PER_RUN_UID}`;
const DATA_ATTRIBUTE_NAME = `data-cq-${PER_RUN_UID}`;

const BLOCK_PREFIX = parseStylesheet(
  Array.from(
    tokenize(
      `* { ${CUSTOM_PROPERTY_TYPE}: initial; ${CUSTOM_PROPERTY_NAME}: initial; }`
    )
  )
).value;

interface ComputedValue<T> {
  (): T;
}

function atom<T>(fn: () => T): ComputedValue<T> {
  return fn;
}

interface MemoizedValue<T> {
  dependencies: Array<[ComputedValue<unknown>, unknown]>;
  value: T;
}

function areDepsDirty<T>(memoizedValue: MemoizedValue<T>) {
  for (const dependency of memoizedValue.dependencies) {
    if (dependency[0]() !== dependency[1]) {
      return true;
    }
  }

  return false;
}

function derive<T>(
  fn: (read: <U>(value: ComputedValue<U>) => U) => T
): ComputedValue<T> {
  let memoizedValue: MemoizedValue<T> | null = null;

  return function getDerivedValue() {
    if (!memoizedValue || areDepsDirty(memoizedValue)) {
      const dependencies: Array<[ComputedValue<unknown>, unknown]> = [];
      const value = fn(value => {
        const res = value();
        dependencies.push([value, res]);
        return res;
      });

      memoizedValue = {dependencies, value};
    }

    return memoizedValue.value;
  };
}

function generateUID(): string {
  return Array.from({length: 4}, () =>
    Math.floor(Math.random() * 256).toString(16)
  ).join('');
}

function parseWritingMode(value?: string): WritingMode {
  if (!value || value.length === 0) {
    return WritingMode.Horizontal;
  }
  const lowerValue = value.toLowerCase();
  if (lowerValue.startsWith('horizontal')) {
    return WritingMode.Horizontal;
  } else if (
    lowerValue.startsWith('vertical') ||
    lowerValue.startsWith('sideways')
  ) {
    return WritingMode.Vertical;
  } else {
    throw new Error('Unsupported writing mode ' + value);
  }
}

function findParentContainerElement(el: Element | null): Element | undefined {
  if (el) {
    if (ELEMENT_TO_CONTAINER.has(el)) {
      return el;
    }
    return findParentContainerElement(el.parentElement);
  }
}

export function preinit() {
  // ...
}

export function init() {
  // ...
}

export function transpileStyleSheet(sheetSrc: string, srcUrl?: string): string {
  function transformStylesheet(node: RuleListBlock): RuleListBlock {
    return {
      ...node,
      value: node.value.map(transformRule),
    };
  }

  function transformRule(
    node: AtRuleNode | QualifiedRuleNode
  ): AtRuleNode | QualifiedRuleNode {
    switch (node.type) {
      case Type.AtRuleNode:
        return transformAtRule(node);

      case Type.QualifiedRuleNode:
        return transformQualifiedRule(node);

      default:
        return node;
    }
  }

  function isEndOfSelector(n1: Node): boolean {
    return n1.type === Type.EOFToken || n1.type === Type.CommaToken;
  }

  function isPseudoElementStart(n1: Node, n2: Node): boolean {
    if (isEndOfSelector(n1)) {
      return true;
    } else if (n1.type === Type.ColonToken) {
      if (n2.type === Type.ColonToken) {
        return true;
      } else if (n2.type === Type.IdentToken) {
        // https://www.w3.org/TR/selectors-4/#single-colon-pseudos
        switch (n2.value.toLowerCase()) {
          case 'before':
          case 'after':
          case 'first-line':
          case 'first-letter':
            return true;
        }
      }
    }
    return false;
  }

  function trimTrailingWhitespace(nodes: Node[]): Node[] {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].type !== Type.WhitespaceToken) {
        return nodes.slice(0, i + 1);
      }
    }
    return nodes;
  }

  function transformSelector(
    nodes: Node[],
    containerUID: string
  ): [Node[], Node[]] {
    const parser = createNodeParser(nodes);
    const elementSelector: Node[] = [];
    const styleSelector: Node[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (parser.at(1).type === Type.EOFToken) {
        return [elementSelector, styleSelector];
      }

      const selectorStartIndex = Math.max(0, parser.index);

      // Consume non-pseudo part
      while (!isPseudoElementStart(parser.at(1), parser.at(2))) {
        parser.consume(1);
      }

      const pseudoStartIndex = parser.index + 1;
      const rawTargetSelector = nodes.slice(
        selectorStartIndex,
        pseudoStartIndex
      );
      const targetSelector =
        rawTargetSelector.length > 0
          ? trimTrailingWhitespace(rawTargetSelector)
          : [
              {
                type: Type.DelimToken,
                value: '*',
              } as Node,
            ];

      // Consume pseudo part
      while (!isEndOfSelector(parser.at(1))) {
        parser.consume(1);
      }

      elementSelector.push(...targetSelector);
      styleSelector.push(...targetSelector);
      styleSelector.push(
        {type: Type.ColonToken},
        {
          type: Type.FunctionNode,
          name: 'where',
          value: [
            {
              type: Type.BlockNode,
              source: {type: Type.LeftSquareBracketToken},
              value: {
                type: BlockType.SimpleBlock,
                value: [
                  {type: Type.IdentToken, value: DATA_ATTRIBUTE_NAME},
                  {type: Type.DelimToken, value: '~'},
                  {type: Type.DelimToken, value: '='},
                  {type: Type.StringToken, value: containerUID},
                ],
              },
            },
          ],
        }
      );
      styleSelector.push(
        ...nodes.slice(pseudoStartIndex, Math.max(0, parser.index + 1))
      );

      // Consume the end of the selector
      parser.consume(1);
    }
  }

  function transformMediaAtRule(node: AtRuleNode): AtRuleNode {
    return {
      ...node,
      value: node.value
        ? {
            ...node.value,
            value: transformStylesheet(parseStylesheet(node.value.value.value)),
          }
        : null,
    };
  }

  function transformSupportsExpression(
    node: GenericExpressionNode
  ): GenericExpressionNode {
    if (node.type === GenericExpressionType.Negate) {
      return {
        ...node,
        value: transformSupportsExpression(node.value),
      };
    } else if (
      node.type === GenericExpressionType.Conjunction ||
      node.type === GenericExpressionType.Disjunction
    ) {
      return {
        ...node,
        left: transformSupportsExpression(node.left),
        right: transformSupportsExpression(node.right),
      };
    } else if (
      node.type === GenericExpressionType.Literal &&
      node.value.type === Type.BlockNode
    ) {
      const declaration = parseDeclaration(node.value.value.value);
      if (declaration) {
        return {
          ...node,
          value: {
            ...node.value,
            value: {
              type: BlockType.SimpleBlock,
              value: [transformPropertyDeclaration(declaration)],
            },
          },
        };
      }
    }
    return node;
  }

  function transformSupportsAtRule(node: AtRuleNode): AtRuleNode {
    let condition = parseMediaCondition(node.prelude);
    condition = condition ? transformSupportsExpression(condition) : null;

    return {
      ...node,
      prelude: condition
        ? transformMediaConditionToTokens(condition)
        : node.prelude,
      value: node.value
        ? {
            ...node.value,
            value: transformStylesheet(parseStylesheet(node.value.value.value)),
          }
        : node.value,
    };
  }

  function transformContainerAtRule(node: AtRuleNode): AtRuleNode {
    if (node.value) {
      const containerRule = parseContainerRule(node.prelude);
      if (containerRule) {
        const uid = `c${CONTAINER_ID++}`;
        const originalRules = transformStylesheet(
          parseStylesheet(node.value.value.value)
        ).value;
        const transformedRules: Array<QualifiedRuleNode> = [];
        const elementSelectors = new Set<string>();

        for (const rule of originalRules) {
          if (rule.type !== Type.QualifiedRuleNode) {
            continue;
          }

          const [elementSelector, styleSelector] = transformSelector(
            rule.prelude,
            uid
          );

          transformedRules.push({
            ...rule,
            prelude: styleSelector,
          });
          elementSelectors.add(elementSelector.map(serialize).join(''));
        }

        CONTAINER_QUERIES.add({
          names: new Set(containerRule.names),
          condition: containerRule.condition,
          selector: Array.from(elementSelectors).join(', '),
          uid,
        });

        return {
          type: Type.AtRuleNode,
          name: 'media',
          prelude: [
            {
              type: Type.IdentToken,
              value: 'all',
            },
          ],
          value: {
            ...node.value,
            value: {
              type: BlockType.RuleList,
              value: [...BLOCK_PREFIX, ...transformedRules],
            },
          },
        };
      }
    }

    return node;
  }

  function transformAtRule(node: AtRuleNode): AtRuleNode {
    switch (node.name.toLocaleLowerCase()) {
      case 'media':
        return transformMediaAtRule(node);

      case 'supports':
        return transformSupportsAtRule(node);

      case 'container':
        return transformContainerAtRule(node);

      default:
        return node;
    }
  }

  function transformContainerDimensions(node: DimensionToken): Node {
    switch (node.unit) {
      case 'cqw':
      case 'cqh':
      case 'cqi':
      case 'cqb':
        return {
          type: Type.FunctionNode,
          name: 'calc',
          value: [],
        };

      case 'cqmin':
        return {
          type: Type.FunctionNode,
          name: 'min',
          value: [],
        };

      case 'cqmax':
        return {
          type: Type.FunctionNode,
          name: 'max',
          value: [],
        };

      default:
        return node;
    }
  }

  function transformContainerUnits(nodes: ReadonlyArray<Node>): Node[] {
    return nodes.map(node => {
      switch (node.type) {
        case Type.DimensionToken:
          return transformContainerDimensions(node);

        case Type.FunctionNode:
          return {
            ...node,
            value: transformContainerUnits(node.value),
          };

        default:
          return node;
      }
    });
  }

  function transformPropertyDeclaration(
    node: DeclarationNode
  ): DeclarationNode {
    if (node.name === 'container') {
      const result = parseContainerShorthand(node.value);
      return result ? {...node, name: CUSTOM_PROPERTY_SHORTHAND} : node;
    } else if (node.name === 'container-name') {
      const result = parseContainerNameProperty(node.value);
      return result ? {...node, name: CUSTOM_PROPERTY_NAME} : node;
    } else if (node.name === 'container-type') {
      const result = parseContainerTypeProperty(node.value);
      return result ? {...node, name: CUSTOM_PROPERTY_TYPE} : node;
    }
    return {
      ...node,
      value: transformContainerUnits(node.value),
    };
  }

  function transformQualifiedRule(node: QualifiedRuleNode): QualifiedRuleNode {
    const declarations: Array<AtRuleNode | DeclarationNode> = [];
    let containerNames: string[] | null = null;
    let containerType: ContainerType | null = null;

    for (const declaration of node.value.value.value) {
      switch (declaration.type) {
        case Type.AtRuleNode:
          {
            const newAtRule = transformAtRule(declaration);
            if (newAtRule) {
              declarations.push(newAtRule);
            }
          }
          break;

        case Type.DeclarationNode:
          {
            const newDeclaration = transformPropertyDeclaration(declaration);
            switch (newDeclaration.name) {
              case CUSTOM_PROPERTY_SHORTHAND: {
                const result = parseContainerShorthand(declaration.value);
                if (result != null) {
                  containerNames = result[0];
                  containerType = result[1];
                }
                break;
              }

              case CUSTOM_PROPERTY_NAME: {
                const result = parseContainerNameProperty(declaration.value);
                if (result != null) {
                  containerNames = result;
                }
                break;
              }

              case CUSTOM_PROPERTY_TYPE: {
                const result = parseContainerTypeProperty(declaration.value);
                if (result != null) {
                  containerType = result;
                }
                break;
              }

              default:
                declarations.push(newDeclaration);
                break;
            }
          }
          break;
      }
    }

    if (containerNames) {
      const containerNameNodes: Node[] = [];
      for (let i = 0; i < containerNames.length; i++) {
        containerNameNodes.push({
          type: Type.IdentToken,
          value: containerNames[i],
        });

        if (i + 1 < containerNames.length) {
          containerNameNodes.push({type: Type.WhitespaceToken});
        }
      }

      declarations.push({
        type: Type.DeclarationNode,
        name: CUSTOM_PROPERTY_NAME,
        value: containerNameNodes,
        important: false,
      });
    }

    if (containerType !== null) {
      declarations.push(
        {
          type: Type.DeclarationNode,
          name: 'contain',
          value: [
            {
              type: Type.IdentToken,
              value: 'size',
            },
            {type: Type.WhitespaceToken},
            {
              type: Type.IdentToken,
              value: 'layout',
            },
            {type: Type.WhitespaceToken},
            {
              type: Type.IdentToken,
              value: 'style',
            },
          ],
          important: false,
        },
        {
          type: Type.DeclarationNode,
          name: CUSTOM_PROPERTY_TYPE,
          value: [
            {
              type: Type.NumberToken,
              value: `${containerType}`,
              flag: NumberFlag.INTEGER,
            },
          ],
          important: false,
        }
      );
    }

    return {
      ...node,
      value: {
        ...node.value,
        value: {
          type: BlockType.StyleBlock,
          value: declarations,
        },
      },
    };
  }

  const tokens = Array.from(tokenize(sheetSrc));
  if (srcUrl) {
    // Ensure any URLs are absolute
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === Type.URLToken) {
        token.value = new URL(token.value, srcUrl).toString();
      } else if (
        token.type === Type.FunctionToken &&
        token.value.toLowerCase() === 'url'
      ) {
        const nextToken = i + 1 < tokens.length ? tokens[i + 1] : null;
        if (nextToken && nextToken.type === Type.StringToken) {
          nextToken.value = new URL(nextToken.value, srcUrl).toString();
        }
      }
    }
  }

  return serializeBlock(transformStylesheet(parseStylesheet(tokens, true)));
}

function hasAllQueryNames(names: Set<string>, query: ContainerQueryDescriptor) {
  for (const name of query.names) {
    if (!names.has(name)) {
      return false;
    }
  }
  return true;
}

const documentElement = document.documentElement;
const rootEl = document.createElement(`cq-polyfill-${PER_RUN_UID}`);
const rootStyles = window.getComputedStyle(rootEl);

rootEl.style.cssText =
  'position: absolute; top: 0; left: 0; right: 0; bottom: 0; visibility: hidden; font-size: 1rem; transition: font-size 1e-8ms;';
documentElement.appendChild(rootEl);

// We use a separate ResizeObserver for tracking the viewport via
// rootEl, so we're not littering the code with checks to prevent
// it from being unobserved.
const viewportResizeObserver = new ResizeObserver(() => {
  documentElement.style.setProperty(
    CUSTOM_PROPERTY_SVW,
    rootEl.clientWidth + 'px'
  );
  documentElement.style.setProperty(
    CUSTOM_PROPERTY_SVH,
    rootEl.clientHeight + 'px'
  );
});
viewportResizeObserver.observe(rootEl);

const rawRootFontSize = atom(() => rootStyles.fontSize);
const rootFontSize = derive(read => parseInt(read(rawRootFontSize)));

const resizeObserver = new ResizeObserver(entries => {
  for (const entry of entries) {
    const container = maybeGetOrCreateContainer(entry.target);
    if (container) {
      container.update(entry.contentRect);
    }
  }
});
resizeObserver.observe(rootEl);

function scheduleContainerUpdate(el: Element) {
  // Schedule the container for an update.
  resizeObserver.unobserve(el);
  resizeObserver.observe(el);
}

function maybeGetOrCreateContainer(el: Element) {
  let container = ELEMENT_TO_CONTAINER.get(el);
  if (!container) {
    const styles = window.getComputedStyle(el);
    const rawContainerType = atom(() =>
      styles.getPropertyValue(CUSTOM_PROPERTY_TYPE)
    );

    if (rawContainerType().length === 0) {
      resizeObserver.unobserve(el);

      forEachElement(el, function updateChildren(childEl) {
        if (el !== childEl && childEl instanceof Element) {
          const childContainer = maybeGetOrCreateContainer(childEl);
          if (childContainer) {
            scheduleContainerUpdate(childEl);
            return false;
          }
        }
        return true;
      });

      return null;
    }

    let rawParentResults: Map<ContainerQueryDescriptor, boolean> | null = null;
    let contentRect: DOMRectReadOnly;

    const rawContainerNames = atom(() =>
      styles.getPropertyValue(CUSTOM_PROPERTY_NAME)
    );
    const rawFontSize = atom(() => styles.getPropertyValue('font-size'));
    const rawWritingMode = atom(() => styles.getPropertyValue('writing-mode'));

    const containerType = derive(read => {
      switch (read(rawContainerType)) {
        case '1':
          return ContainerType.Size;
        case '2':
          return ContainerType.InlineSize;
        default:
          return ContainerType.None;
      }
    });
    const containerNames = derive(read => {
      const names = read(rawContainerNames);
      return new Set(names.length === 0 ? [] : names.split(' '));
    });
    const fontSize = derive(read => parseInt(read(rawFontSize)));
    const writingMode = derive(read => parseWritingMode(read(rawWritingMode)));

    const width = atom(() => contentRect.width);
    const height = atom(() => contentRect.height);
    const parentResults = atom(() => rawParentResults);

    const context: ComputedValue<QueryContext> = derive(read => ({
      type: read(containerType),
      fontSize: read(fontSize),
      rootFontSize: read(rootFontSize),
      writingMode: read(writingMode),
      width: read(width),
      height: read(height),
    }));

    const containerQueries = atom(() => CONTAINER_QUERIES.values());
    const getQueryResults = derive(read => {
      const type = read(containerType);
      if (type === ContainerType.None) {
        return null;
      }

      const res: Map<ContainerQueryDescriptor, boolean> = new Map(
        read(parentResults)
      );
      const ctx = read(context);
      const names = read(containerNames);

      for (const query of read(containerQueries)) {
        if (!hasAllQueryNames(names, query)) {
          continue;
        }
        res.set(query, evaluateContainerCondition(query.condition, ctx));
      }

      return res;
    });

    container = {
      update(newContentRect) {
        contentRect = newContentRect;
        const localResults = getQueryResults();
        const results = localResults ? localResults : rawParentResults;
        const matches: string[] = [];

        forEachElement(el, function updateContainerElements(childEl) {
          if (childEl instanceof Element) {
            if (results) {
              for (const [query, result] of results) {
                if (result && childEl.matches(query.selector)) {
                  matches.push(query.uid);
                }
              }
            }

            if (matches.length > 0) {
              childEl.setAttribute(DATA_ATTRIBUTE_NAME, matches.join(' '));
              matches.length = 0;
            } else {
              childEl.removeAttribute(DATA_ATTRIBUTE_NAME);
            }

            if (childEl !== el) {
              const childContainer = maybeGetOrCreateContainer(childEl);
              if (childContainer) {
                childContainer.setParentResults(results);
                scheduleContainerUpdate(childEl);
                return false;
              }
            }
          }

          return true;
        });

        if (!results) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          container!.dispose();
        }
      },
      setParentResults(results) {
        rawParentResults = results;
      },
      dispose() {
        rawParentResults = null;
        resizeObserver.unobserve(el);
        ELEMENT_TO_CONTAINER.delete(el);
      },
    };

    ELEMENT_TO_CONTAINER.set(el, container);
  }
  return container;
}

['transitionstart', 'transitionend', 'animationstart', 'animationend'].forEach(
  name => {
    window.addEventListener(name, e => {
      if (e.target === rootEl) {
        for (const el of ELEMENT_TO_CONTAINER.keys()) {
          scheduleContainerUpdate(el);
        }
      } else if (e.target instanceof HTMLElement) {
        scheduleContainerUpdate(e.target);
      }
    });
  }
);

export function findNewContainers() {
  scheduleContainerUpdate(documentElement);
}

const mutationObserver = new MutationObserver(entries => {
  for (const entry of entries) {
    if (
      entry.attributeName === DATA_ATTRIBUTE_NAME ||
      entry.target === rootEl
    ) {
      continue;
    } else if (
      entry.target instanceof HTMLLinkElement ||
      entry.target instanceof HTMLStyleElement
    ) {
      scheduleContainerUpdate(documentElement);
      continue;
    }

    for (const node of entry.removedNodes) {
      forEachElement(node, el => {
        if (el instanceof HTMLElement) {
          el.removeAttribute(DATA_ATTRIBUTE_NAME);
          const container = ELEMENT_TO_CONTAINER.get(el);
          if (container) {
            container.dispose();
          }
        }
        return true;
      });
    }

    /**
     * Note: We don't want to traverse through added/updated nodes here,
     * because we're going to do that in the ResizeObserver.
     */
    if (entry.target instanceof Element) {
      const containerElement = findParentContainerElement(entry.target);
      scheduleContainerUpdate(
        containerElement ? containerElement : entry.target
      );
    }
  }
});
mutationObserver.observe(document, {
  childList: true,
  subtree: true,
  attributes: true,
});

function forEachElement(
  el: globalThis.Node,
  callback: (el: globalThis.Node) => boolean
) {
  callback(el);
  for (const childEl of el.childNodes) {
    if (callback(childEl)) {
      forEachElement(childEl, callback);
    }
  }
}
