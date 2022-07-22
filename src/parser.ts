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
  ContainerType,
  ExpressionNode,
  ExpressionType,
  SizeFeature,
  Value,
  ValueType,
} from './evaluate.js';
import {
  consumeWhitespace,
  createNodeParser,
  Node,
  Parser,
  Type,
} from './utils/css.js';
import {consumeMediaFeature, FeatureType} from './utils/parse-media-feature.js';
import {
  consumeMediaCondition,
  GenericExpressionNode,
  GenericExpressionType,
} from './utils/parse-media-query.js';

export interface ContainerRule {
  names: string[];
  condition: ExpressionNode;
}

const SIZE_FEATURE_MAP: Record<string, SizeFeature> = {
  width: SizeFeature.Width,
  height: SizeFeature.Height,
  'inline-size': SizeFeature.InlineSize,
  'block-size': SizeFeature.BlockSize,
  'aspect-ratio': SizeFeature.AspectRatio,
  orientation: SizeFeature.Orientation,
};
const FEATURE_NAMES = new Set(Object.keys(SIZE_FEATURE_MAP));

function consumeMaybeSeparatedByDelim<A, B>(
  parser: Parser<Node>,
  delim: string,
  consumeA: () => A,
  consumeB: () => B
): [A, B | null] | null {
  const first = consumeA();
  if (first === null) {
    return null;
  }

  let res: [A, B | null] = [first, null];
  consumeWhitespace(parser);
  const next = parser.at(1);
  if (next.type === Type.DelimToken) {
    if (next.value !== delim) {
      return null;
    }

    parser.consume(1);
    consumeWhitespace(parser);
    const second = consumeB();
    consumeWhitespace(parser);

    if (second !== null) {
      res = [first, second];
    }
  }

  return parser.at(1).type === Type.EOFToken ? res : null;
}

function consumeNumber(parser: Parser<Node>): number | null {
  const node = parser.consume(1);
  return node.type === Type.NumberToken ? parseInt(node.value) : null;
}

function consumeNumberOrRatio(parser: Parser<Node>): Value | null {
  const result = consumeMaybeSeparatedByDelim(
    parser,
    '/',
    () => consumeNumber(parser),
    () => consumeNumber(parser)
  );
  if (result === null) {
    return null;
  }

  const numerator = result[0];
  const denominator = result[1] !== null ? result[1] : 1;

  return numerator !== null
    ? {type: ValueType.Number, value: numerator / denominator}
    : null;
}

function consumeValue(nodes: ReadonlyArray<Node>): ExpressionNode | null {
  const parser = createNodeParser(nodes);
  consumeWhitespace(parser);

  const node = parser.consume(1);
  let value: Value | null = null;

  switch (node.type) {
    case Type.NumberToken:
      parser.reconsume();
      value = consumeNumberOrRatio(parser);
      break;

    case Type.DimensionToken:
      value = {
        type: ValueType.Dimension,
        value: parseInt(node.value),
        unit: node.unit.toLowerCase(),
      } as Value;
      break;

    case Type.IdentToken:
      switch (node.value.toLowerCase()) {
        case 'landscape':
          value = {type: ValueType.Orientation, value: 'landscape'} as Value;
          break;

        case 'portrait':
          value = {type: ValueType.Orientation, value: 'portrait'} as Value;
          break;
      }
  }

  if (value === null) {
    return null;
  }

  consumeWhitespace(parser);
  if (parser.at(1).type !== Type.EOFToken) {
    return null;
  }
  return {type: ExpressionType.Value, value};
}

function parseSizeFeature(parser: Parser<Node>): ExpressionNode | null {
  const mediaFeature = consumeMediaFeature(parser, FEATURE_NAMES);
  if (mediaFeature === null) {
    return null;
  }

  if (mediaFeature.type === FeatureType.Boolean) {
    const feature = SIZE_FEATURE_MAP[mediaFeature.feature];
    return feature !== null ? {type: ExpressionType.Feature, feature} : null;
  } else {
    const feature = SIZE_FEATURE_MAP[mediaFeature.feature];
    if (feature === null) {
      return null;
    }

    const featureValue = {type: ExpressionType.Feature, feature};
    let left: ExpressionNode | null = null;

    if (mediaFeature.bounds[0] !== null) {
      const value = consumeValue(mediaFeature.bounds[0][1]);
      if (value === null) {
        return null;
      }
      left = {
        type: ExpressionType.Comparison,
        operator: mediaFeature.bounds[0][0],
        left: value,
        right: featureValue,
      } as ExpressionNode;
    }
    if (mediaFeature.bounds[1] !== null) {
      const value = consumeValue(mediaFeature.bounds[1][1]);
      if (value === null) {
        return null;
      }
      const right: ExpressionNode = {
        type: ExpressionType.Comparison,
        operator: mediaFeature.bounds[1][0],
        left: featureValue,
        right: value,
      } as ExpressionNode;
      left = left
        ? {
            type: ExpressionType.Conjunction,
            left,
            right,
          }
        : right;
    }

    return left;
  }
}

function isValidContainerName(name: string) {
  switch (name.toLowerCase()) {
    case 'none':
    case 'and':
    case 'not':
    case 'or':
    case 'normal':
    case 'auto':
      return false;

    default:
      return true;
  }
}

function consumeContainerNames(
  parser: Parser<Node>,
  expectEof: boolean
): string[] | null {
  const names: string[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    consumeWhitespace(parser);
    const next = parser.at(1);

    if (next.type !== Type.IdentToken) {
      break;
    }

    const name = next.value;
    if (!isValidContainerName(name)) {
      break;
    }

    parser.consume(1);
    names.push(name);
  }

  return expectEof && parser.at(1).type !== Type.EOFToken ? null : names;
}

function consumeContainerType(parser: Parser<Node>): ContainerType | null {
  consumeWhitespace(parser);
  const node = parser.consume(1);
  consumeWhitespace(parser);

  if (node.type !== Type.IdentToken || parser.at(1).type !== Type.EOFToken) {
    return null;
  }

  switch (node.value.toLowerCase()) {
    case 'normal':
    case 'initial':
      return ContainerType.Normal;

    case 'size':
      return ContainerType.Size;

    case 'inline-size':
      return ContainerType.InlineSize;

    default:
      return null;
  }
}

export function parseContainerNameProperty(
  nodes: ReadonlyArray<Node>
): string[] | null {
  return consumeContainerNames(createNodeParser(nodes), true);
}

export function parseContainerTypeProperty(
  nodes: ReadonlyArray<Node>
): ContainerType | null {
  return consumeContainerType(createNodeParser(nodes));
}

export function parseContainerShorthand(
  nodes: ReadonlyArray<Node>
): [string[] | null, ContainerType | null] | null {
  const parser = createNodeParser(nodes);
  const result = consumeMaybeSeparatedByDelim(
    parser,
    '/',
    () => consumeContainerNames(parser, false),
    () => consumeContainerType(parser)
  );

  return result === null || result[0] === null ? null : result;
}

export function parseContainerRule(
  nodes: ReadonlyArray<Node>
): ContainerRule | null {
  const parser = createNodeParser(nodes);
  const names = consumeContainerNames(parser, false);

  if (!names || names.length > 1) {
    return null;
  }

  const condition = transformExpression(consumeMediaCondition(parser));
  if (!condition) {
    return null;
  }

  consumeWhitespace(parser);
  if (parser.at(1).type !== Type.EOFToken) {
    return null;
  }

  return {names, condition};
}

function transformExpression(
  node: GenericExpressionNode | null
): ExpressionNode | null {
  if (!node) {
    return null;
  }

  if (node.type === GenericExpressionType.Negate) {
    const value = transformExpression(node.value);
    return value
      ? {
          type: ExpressionType.Negate,
          value,
        }
      : null;
  } else if (
    node.type === GenericExpressionType.Conjunction ||
    node.type === GenericExpressionType.Disjunction
  ) {
    const left = transformExpression(node.left);
    const right = transformExpression(node.right);
    return left && right
      ? {
          type:
            node.type === GenericExpressionType.Conjunction
              ? ExpressionType.Conjunction
              : ExpressionType.Disjunction,
          left,
          right,
        }
      : null;
  } else if (node.type === GenericExpressionType.Literal) {
    if (node.value.type === Type.BlockNode) {
      const expression = parseSizeFeature(
        createNodeParser(node.value.value.value)
      );
      if (expression) {
        return expression;
      }
    }
    return {type: ExpressionType.Value, value: {type: ValueType.Unknown}};
  }
  return null;
}
