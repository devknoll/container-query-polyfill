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

import {
  CUSTOM_PROPERTY_NAME,
  CUSTOM_PROPERTY_SHORTHAND,
  CUSTOM_PROPERTY_TYPE,
  CUSTOM_UNIT_VARIABLE_CQB,
  CUSTOM_UNIT_VARIABLE_CQH,
  CUSTOM_UNIT_VARIABLE_CQI,
  CUSTOM_UNIT_VARIABLE_CQW,
  DATA_ATTRIBUTE_NAME,
} from './constants.js';
import {ContainerType, ExpressionNode} from './evaluate.js';
import {
  parseContainerRule,
  parseContainerShorthand,
  parseContainerNameProperty,
  parseContainerTypeProperty,
} from './parser.js';
import {
  AtRuleNode,
  BlockType,
  createNodeParser,
  DeclarationNode,
  DimensionToken,
  Node,
  NumberFlag,
  parseDeclaration,
  parseStylesheet,
  QualifiedRuleNode,
  RuleListBlock,
  serialize,
  serializeBlock,
  tokenize,
  Type,
} from './utils/css.js';
import {
  GenericExpressionNode,
  GenericExpressionType,
  parseMediaCondition,
  transformMediaConditionToTokens,
} from './utils/parse-media-query.js';

export interface ContainerQueryDescriptor {
  names: Set<string>;
  condition: ExpressionNode;
  uid: string;
  selector: string;
}

let CONTAINER_ID = 0;
const CUSTOM_UNIT_MAP = {
  cqw: CUSTOM_UNIT_VARIABLE_CQW,
  cqh: CUSTOM_UNIT_VARIABLE_CQH,
  cqi: CUSTOM_UNIT_VARIABLE_CQI,
  cqb: CUSTOM_UNIT_VARIABLE_CQB,
};

const BLOCK_PREFIX = parseStylesheet(
  Array.from(
    tokenize(
      `* { ${CUSTOM_PROPERTY_TYPE}: initial; ${CUSTOM_PROPERTY_NAME}: initial; }`
    )
  )
).value;

export function transpileStyleSheet(
  sheetSrc: string,
  srcUrl?: string
): [string, ContainerQueryDescriptor[]] {
  const queryDescriptors: ContainerQueryDescriptor[] = [];

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
        func('where', [
          {
            type: Type.BlockNode,
            source: {type: Type.LeftSquareBracketToken},
            value: {
              type: BlockType.SimpleBlock,
              value: [
                ident(DATA_ATTRIBUTE_NAME),
                delim('~'),
                delim('='),
                {type: Type.StringToken, value: containerUID},
              ],
            },
          },
        ])
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

        if (elementSelectors.size > 0) {
          queryDescriptors.push({
            names: new Set(containerRule.names),
            condition: containerRule.condition,
            selector: Array.from(elementSelectors).join(', '),
            uid,
          });
        }

        return {
          type: Type.AtRuleNode,
          name: 'media',
          prelude: [ident('all')],
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
    let unit: Node;

    switch (node.unit) {
      case 'cqw':
      case 'cqh':
      case 'cqi':
      case 'cqb':
        unit = customVar(CUSTOM_UNIT_MAP[node.unit]);
        break;

      case 'cqmin':
      case 'cqmax':
        unit = func(node.unit.slice(2), [
          customVar(CUSTOM_UNIT_VARIABLE_CQI),
          {type: Type.CommaToken},
          customVar(CUSTOM_UNIT_VARIABLE_CQB),
        ]);
        break;

      default:
        return node;
    }

    return func('calc', [
      {type: Type.NumberToken, flag: node.flag, value: node.value},
      delim('*'),
      unit,
    ]);
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
      return result != null ? {...node, name: CUSTOM_PROPERTY_TYPE} : node;
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
          containerNameNodes.push(ws);
        }
      }

      declarations.push(decl(CUSTOM_PROPERTY_NAME, containerNameNodes));
    }

    if (containerType !== null) {
      declarations.push(
        decl(
          'contain',
          containerType === ContainerType.Normal
            ? [ident('initial')]
            : [
                ...(containerType === ContainerType.Size
                  ? [ident('size'), ws]
                  : []),
                ident('layout'),
                ws,
                ident('style'),
              ]
        ),
        decl(CUSTOM_PROPERTY_TYPE, [int(`${containerType}`)])
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

  return [
    serializeBlock(transformStylesheet(parseStylesheet(tokens, true))),
    queryDescriptors,
  ];
}

const ws: Node = {type: Type.WhitespaceToken};

function delim(value: string): Node {
  return {type: Type.DelimToken, value};
}

function decl(name: string, value: Node[]): DeclarationNode {
  return {
    type: Type.DeclarationNode,
    name,
    value,
    important: false,
  };
}

function ident(value: string): Node {
  return {type: Type.IdentToken, value};
}

function func(name: string, value: Node[]): Node {
  return {type: Type.FunctionNode, name, value};
}

function int(value: string): Node {
  return {type: Type.NumberToken, value: value, flag: NumberFlag.INTEGER};
}

function customVar(name: string) {
  return func('var', [ident(name)]);
}
