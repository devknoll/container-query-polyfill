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
  Node,
  Parser,
  consumeWhitespace,
  Type,
  createNodeParser,
} from './css.js';

export const enum GenericExpressionType {
  Negate = 1,
  Conjunction,
  Disjunction,
  Literal,
}

export type GenericExpressionNode =
  | GenericNegateExpressionNode
  | GenericConjunctionExpressionNode
  | GenericDisjunctionExpressionNode
  | GenericLiteralExpressionNode;

export interface GenericNegateExpressionNode {
  type: GenericExpressionType.Negate;
  value: GenericExpressionNode;
}

export interface GenericConjunctionExpressionNode {
  type: GenericExpressionType.Conjunction;
  left: GenericExpressionNode;
  right: GenericExpressionNode;
}

export interface GenericDisjunctionExpressionNode {
  type: GenericExpressionType.Disjunction;
  left: GenericExpressionNode;
  right: GenericExpressionNode;
}

export interface GenericLiteralExpressionNode {
  type: GenericExpressionType.Literal;
  value: Node;
}

function parseQueryCondition(
  parser: Parser<Node>,
  topLevel: boolean,
  andOr: 'and' | 'or' | null
): GenericExpressionNode | null {
  consumeWhitespace(parser);

  let negated = false;
  let next: Node = parser.at(1);

  if (
    topLevel &&
    next.type !== Type.FunctionNode &&
    (next.type !== Type.BlockNode ||
      next.source.type !== Type.LeftParenthesisToken)
  ) {
    // TODO: WPT currently assumes the top level of a condition
    // is a function or enclosed in parens. Fix this when clarified.
    return null;
  }

  if (next.type === Type.IdentToken) {
    if (next.value.toLowerCase() !== 'not') {
      return null;
    }
    parser.consume(1);
    consumeWhitespace(parser);
    negated = true;
  }

  let left = parseQueryInParens(parser);
  if (left === null) {
    return null;
  }
  left = negated
    ? {
        type: GenericExpressionType.Negate,
        value: left,
      }
    : left;

  consumeWhitespace(parser);
  next = parser.at(1);

  if (topLevel && next.type !== Type.EOFToken) {
    // TODO: WPT currently assumes the top level of a condition
    // is a function or enclosed in parens. Fix this when clarified.
    return null;
  }

  const nextAndOr =
    next.type === Type.IdentToken ? next.value.toLowerCase() : null;

  if (nextAndOr !== null) {
    parser.consume(1);
    consumeWhitespace(parser);

    if (
      (nextAndOr !== 'and' && nextAndOr !== 'or') ||
      (andOr !== null && nextAndOr !== andOr)
    ) {
      return null;
    }

    const right = parseQueryCondition(parser, false, nextAndOr);
    if (right === null) {
      return null;
    }

    return {
      type:
        nextAndOr === 'and'
          ? GenericExpressionType.Conjunction
          : GenericExpressionType.Disjunction,
      left,
      right,
    } as GenericExpressionNode;
  }

  return parser.at(1).type === Type.EOFToken ? left : null;
}

function parseQueryInParens(
  parser: Parser<Node>
): GenericExpressionNode | null {
  const node = parser.consume(1);

  switch (node.type) {
    case Type.BlockNode: {
      if (node.source.type !== Type.LeftParenthesisToken) {
        return null;
      }

      const maybeContainerCondition = parseQueryCondition(
        createNodeParser(node.value.value),
        false,
        null
      );
      if (maybeContainerCondition) {
        return maybeContainerCondition;
      }

      return {type: GenericExpressionType.Literal, value: node};
    }

    case Type.FunctionNode:
      return {type: GenericExpressionType.Literal, value: node};

    default:
      return null;
  }
}

export function consumeMediaCondition(
  parser: Parser<Node>
): GenericExpressionNode | null {
  return parseQueryCondition(parser, false, null);
}

export function consumeMediaConditionInParens(
  parser: Parser<Node>
): GenericExpressionNode | null {
  return parseQueryInParens(parser);
}

export function parseMediaCondition(
  nodes: ReadonlyArray<Node>
): GenericExpressionNode | null {
  return consumeMediaCondition(createNodeParser(nodes));
}

export function transformMediaConditionToTokens(
  node: GenericExpressionNode
): Node[] {
  switch (node.type) {
    case GenericExpressionType.Negate:
      return [
        {type: Type.IdentToken, value: 'not'},
        {type: Type.WhitespaceToken},
        ...transformMediaConditionToTokens(node.value),
      ];

    case GenericExpressionType.Conjunction:
    case GenericExpressionType.Disjunction:
      return [
        ...transformMediaConditionToTokens(node.left),
        {type: Type.WhitespaceToken},
        {
          type: Type.IdentToken,
          value: node.type === GenericExpressionType.Conjunction ? 'and' : 'or',
        },
        {type: Type.WhitespaceToken},
        ...transformMediaConditionToTokens(node.right),
      ];

    case GenericExpressionType.Literal:
      return [node.value];
  }
}
