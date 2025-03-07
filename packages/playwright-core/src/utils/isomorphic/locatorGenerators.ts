/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { escapeWithQuotes, toSnakeCase, toTitleCase } from './stringUtils';
import { type NestedSelectorBody, parseAttributeSelector, parseSelector, stringifySelector } from './selectorParser';
import type { ParsedSelector } from './selectorParser';

export type Language = 'javascript' | 'python' | 'java' | 'csharp';
export type LocatorType = 'default' | 'role' | 'text' | 'label' | 'placeholder' | 'alt' | 'title' | 'test-id' | 'nth' | 'first' | 'last' | 'has-text' | 'has' | 'frame' | 'or' | 'and' | 'not';
export type LocatorBase = 'page' | 'locator' | 'frame-locator';

type LocatorOptions = { attrs?: { name: string, value: string | boolean | number}[], exact?: boolean, name?: string | RegExp };
export interface LocatorFactory {
  generateLocator(base: LocatorBase, kind: LocatorType, body: string | RegExp, options?: LocatorOptions): string;
}

export function asLocator(lang: Language, selector: string, isFrameLocator: boolean = false, playSafe: boolean = false): string {
  if (playSafe) {
    try {
      return innerAsLocator(generators[lang], parseSelector(selector), isFrameLocator);
    } catch (e) {
      // Tolerate invalid input.
      return selector;
    }
  } else {
    return innerAsLocator(generators[lang], parseSelector(selector), isFrameLocator);
  }
}

function innerAsLocator(factory: LocatorFactory, parsed: ParsedSelector, isFrameLocator: boolean = false): string {
  const parts = [...parsed.parts];
  // frameLocator('iframe').first is actually "iframe >> nth=0 >> internal:control=enter-frame"
  // To make it easier to parse, we turn it into "iframe >> internal:control=enter-frame >> nth=0"
  for (let index = 0; index < parts.length - 1; index++) {
    if (parts[index].name === 'nth' && parts[index + 1].name === 'internal:control' && (parts[index + 1].body as string) === 'enter-frame') {
      // Swap nth and enter-frame.
      const [nth] = parts.splice(index, 1);
      parts.splice(index + 1, 0, nth);
    }
  }

  const tokens: string[] = [];
  let nextBase: LocatorBase = isFrameLocator ? 'frame-locator' : 'page';
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const base = nextBase;
    nextBase = 'locator';

    if (part.name === 'nth') {
      if (part.body === '0')
        tokens.push(factory.generateLocator(base, 'first', ''));
      else if (part.body === '-1')
        tokens.push(factory.generateLocator(base, 'last', ''));
      else
        tokens.push(factory.generateLocator(base, 'nth', part.body as string));
      continue;
    }
    if (part.name === 'internal:text') {
      const { exact, text } = detectExact(part.body as string);
      tokens.push(factory.generateLocator(base, 'text', text, { exact }));
      continue;
    }
    if (part.name === 'internal:has-text') {
      const { exact, text } = detectExact(part.body as string);
      // There is no locator equivalent for strict has-text, leave it as is.
      if (!exact) {
        tokens.push(factory.generateLocator(base, 'has-text', text, { exact }));
        continue;
      }
    }
    if (part.name === 'internal:has') {
      const inner = innerAsLocator(factory, (part.body as NestedSelectorBody).parsed);
      tokens.push(factory.generateLocator(base, 'has', inner));
      continue;
    }
    if (part.name === 'internal:or') {
      const inner = innerAsLocator(factory, (part.body as NestedSelectorBody).parsed);
      tokens.push(factory.generateLocator(base, 'or', inner));
      continue;
    }
    if (part.name === 'internal:and') {
      const inner = innerAsLocator(factory, (part.body as NestedSelectorBody).parsed);
      tokens.push(factory.generateLocator(base, 'and', inner));
      continue;
    }
    if (part.name === 'internal:not') {
      const inner = innerAsLocator(factory, (part.body as NestedSelectorBody).parsed);
      tokens.push(factory.generateLocator(base, 'not', inner));
      continue;
    }
    if (part.name === 'internal:label') {
      const { exact, text } = detectExact(part.body as string);
      tokens.push(factory.generateLocator(base, 'label', text, { exact }));
      continue;
    }
    if (part.name === 'internal:role') {
      const attrSelector = parseAttributeSelector(part.body as string, true);
      const options: LocatorOptions = { attrs: [] };
      for (const attr of attrSelector.attributes) {
        if (attr.name === 'name') {
          options.exact = attr.caseSensitive;
          options.name = attr.value;
        } else {
          if (attr.name === 'level' && typeof attr.value === 'string')
            attr.value = +attr.value;
          options.attrs!.push({ name: attr.name === 'include-hidden' ? 'includeHidden' : attr.name, value: attr.value });
        }
      }
      tokens.push(factory.generateLocator(base, 'role', attrSelector.name, options));
      continue;
    }
    if (part.name === 'internal:testid') {
      const attrSelector = parseAttributeSelector(part.body as string, true);
      const { value } = attrSelector.attributes[0];
      tokens.push(factory.generateLocator(base, 'test-id', value));
      continue;
    }
    if (part.name === 'internal:attr') {
      const attrSelector = parseAttributeSelector(part.body as string, true);
      const { name, value, caseSensitive } = attrSelector.attributes[0];
      const text = value as string | RegExp;
      const exact = !!caseSensitive;
      if (name === 'placeholder') {
        tokens.push(factory.generateLocator(base, 'placeholder', text, { exact }));
        continue;
      }
      if (name === 'alt') {
        tokens.push(factory.generateLocator(base, 'alt', text, { exact }));
        continue;
      }
      if (name === 'title') {
        tokens.push(factory.generateLocator(base, 'title', text, { exact }));
        continue;
      }
    }

    let locatorType: LocatorType = 'default';

    const nextPart = parts[index + 1];
    if (nextPart && nextPart.name === 'internal:control' && (nextPart.body as string) === 'enter-frame') {
      locatorType = 'frame';
      nextBase = 'frame-locator';
      index++;
    }

    const p: ParsedSelector = { parts: [part] };
    tokens.push(factory.generateLocator(base, locatorType, stringifySelector(p)));
  }
  return tokens.join('.');
}

function detectExact(text: string): { exact?: boolean, text: string | RegExp } {
  let exact = false;
  const match = text.match(/^\/(.*)\/([igm]*)$/);
  if (match)
    return { text: new RegExp(match[1], match[2]) };
  if (text.endsWith('"')) {
    text = JSON.parse(text);
    exact = true;
  } else if (text.endsWith('"s')) {
    text = JSON.parse(text.substring(0, text.length - 1));
    exact = true;
  } else if (text.endsWith('"i')) {
    text = JSON.parse(text.substring(0, text.length - 1));
    exact = false;
  }
  return { exact, text };
}

export class JavaScriptLocatorFactory implements LocatorFactory {
  generateLocator(base: LocatorBase, kind: LocatorType, body: string | RegExp, options: LocatorOptions = {}): string {
    switch (kind) {
      case 'default':
        return `locator(${this.quote(body as string)})`;
      case 'frame':
        return `frameLocator(${this.quote(body as string)})`;
      case 'nth':
        return `nth(${body})`;
      case 'first':
        return `first()`;
      case 'last':
        return `last()`;
      case 'role':
        const attrs: string[] = [];
        if (isRegExp(options.name)) {
          attrs.push(`name: ${options.name}`);
        } else if (typeof options.name === 'string') {
          attrs.push(`name: ${this.quote(options.name)}`);
          if (options.exact)
            attrs.push(`exact: true`);
        }
        for (const { name, value } of options.attrs!)
          attrs.push(`${name}: ${typeof value === 'string' ? this.quote(value) : value}`);
        const attrString = attrs.length ? `, { ${attrs.join(', ')} }` : '';
        return `getByRole(${this.quote(body as string)}${attrString})`;
      case 'has-text':
        return `filter({ hasText: ${this.toHasText(body as string)} })`;
      case 'has':
        return `filter({ has: ${body} })`;
      case 'or':
        return `or(${body})`;
      case 'and':
        return `and(${body})`;
      case 'not':
        return `not(${body})`;
      case 'test-id':
        return `getByTestId(${this.quote(body as string)})`;
      case 'text':
        return this.toCallWithExact('getByText', body, !!options.exact);
      case 'alt':
        return this.toCallWithExact('getByAltText', body, !!options.exact);
      case 'placeholder':
        return this.toCallWithExact('getByPlaceholder', body, !!options.exact);
      case 'label':
        return this.toCallWithExact('getByLabel', body, !!options.exact);
      case 'title':
        return this.toCallWithExact('getByTitle', body, !!options.exact);
      default:
        throw new Error('Unknown selector kind ' + kind);
    }
  }

  private toCallWithExact(method: string, body: string | RegExp, exact?: boolean) {
    if (isRegExp(body))
      return `${method}(${body})`;
    return exact ? `${method}(${this.quote(body)}, { exact: true })` : `${method}(${this.quote(body)})`;
  }

  private toHasText(body: string | RegExp) {
    if (isRegExp(body))
      return String(body);
    return this.quote(body);
  }

  private quote(text: string) {
    return escapeWithQuotes(text, '\'');
  }
}

export class PythonLocatorFactory implements LocatorFactory {
  generateLocator(base: LocatorBase, kind: LocatorType, body: string | RegExp, options: LocatorOptions = {}): string {
    switch (kind) {
      case 'default':
        return `locator(${this.quote(body as string)})`;
      case 'frame':
        return `frame_locator(${this.quote(body as string)})`;
      case 'nth':
        return `nth(${body})`;
      case 'first':
        return `first`;
      case 'last':
        return `last`;
      case 'role':
        const attrs: string[] = [];
        if (isRegExp(options.name)) {
          attrs.push(`name=${this.regexToString(options.name)}`);
        } else if (typeof options.name === 'string') {
          attrs.push(`name=${this.quote(options.name)}`);
          if (options.exact)
            attrs.push(`exact=True`);
        }
        for (const { name, value } of options.attrs!) {
          let valueString = typeof value === 'string' ? this.quote(value) : value;
          if (typeof value === 'boolean')
            valueString = value ? 'True' : 'False';
          attrs.push(`${toSnakeCase(name)}=${valueString}`);
        }
        const attrString = attrs.length ? `, ${attrs.join(', ')}` : '';
        return `get_by_role(${this.quote(body as string)}${attrString})`;
      case 'has-text':
        return `filter(has_text=${this.toHasText(body as string)})`;
      case 'has':
        return `filter(has=${body})`;
      case 'or':
        return `or_(${body})`;
      case 'and':
        return `and_(${body})`;
      case 'not':
        return `not_(${body})`;
      case 'test-id':
        return `get_by_test_id(${this.quote(body as string)})`;
      case 'text':
        return this.toCallWithExact('get_by_text', body, !!options.exact);
      case 'alt':
        return this.toCallWithExact('get_by_alt_text', body, !!options.exact);
      case 'placeholder':
        return this.toCallWithExact('get_by_placeholder', body, !!options.exact);
      case 'label':
        return this.toCallWithExact('get_by_label', body, !!options.exact);
      case 'title':
        return this.toCallWithExact('get_by_title', body, !!options.exact);
      default:
        throw new Error('Unknown selector kind ' + kind);
    }
  }

  private regexToString(body: RegExp) {
    const suffix = body.flags.includes('i') ? ', re.IGNORECASE' : '';
    return `re.compile(r"${body.source.replace(/\\\//, '/').replace(/"/g, '\\"')}"${suffix})`;
  }

  private toCallWithExact(method: string, body: string | RegExp, exact: boolean) {
    if (isRegExp(body))
      return `${method}(${this.regexToString(body)})`;
    if (exact)
      return `${method}(${this.quote(body)}, exact=True)`;
    return `${method}(${this.quote(body)})`;
  }

  private toHasText(body: string | RegExp) {
    if (isRegExp(body))
      return this.regexToString(body);
    return `${this.quote(body)}`;
  }

  private quote(text: string) {
    return escapeWithQuotes(text, '\"');
  }
}

export class JavaLocatorFactory implements LocatorFactory {
  generateLocator(base: LocatorBase, kind: LocatorType, body: string | RegExp, options: LocatorOptions = {}): string {
    let clazz: string;
    switch (base) {
      case 'page': clazz = 'Page'; break;
      case 'frame-locator': clazz = 'FrameLocator'; break;
      case 'locator': clazz = 'Locator'; break;
    }
    switch (kind) {
      case 'default':
        return `locator(${this.quote(body as string)})`;
      case 'frame':
        return `frameLocator(${this.quote(body as string)})`;
      case 'nth':
        return `nth(${body})`;
      case 'first':
        return `first()`;
      case 'last':
        return `last()`;
      case 'role':
        const attrs: string[] = [];
        if (isRegExp(options.name)) {
          attrs.push(`.setName(${this.regexToString(options.name)})`);
        } else if (typeof options.name === 'string') {
          attrs.push(`.setName(${this.quote(options.name)})`);
          if (options.exact)
            attrs.push(`.setExact(true)`);
        }
        for (const { name, value } of options.attrs!)
          attrs.push(`.set${toTitleCase(name)}(${typeof value === 'string' ? this.quote(value) : value})`);
        const attrString = attrs.length ? `, new ${clazz}.GetByRoleOptions()${attrs.join('')}` : '';
        return `getByRole(AriaRole.${toSnakeCase(body as string).toUpperCase()}${attrString})`;
      case 'has-text':
        return `filter(new ${clazz}.FilterOptions().setHasText(${this.toHasText(body)}))`;
      case 'has':
        return `filter(new ${clazz}.FilterOptions().setHas(${body}))`;
      case 'or':
        return `or(${body})`;
      case 'and':
        return `and(${body})`;
      case 'not':
        return `not(${body})`;
      case 'test-id':
        return `getByTestId(${this.quote(body as string)})`;
      case 'text':
        return this.toCallWithExact(clazz, 'getByText', body, !!options.exact);
      case 'alt':
        return this.toCallWithExact(clazz, 'getByAltText', body, !!options.exact);
      case 'placeholder':
        return this.toCallWithExact(clazz, 'getByPlaceholder', body, !!options.exact);
      case 'label':
        return this.toCallWithExact(clazz, 'getByLabel', body, !!options.exact);
      case 'title':
        return this.toCallWithExact(clazz, 'getByTitle', body, !!options.exact);
      default:
        throw new Error('Unknown selector kind ' + kind);
    }
  }

  private regexToString(body: RegExp) {
    const suffix = body.flags.includes('i') ? ', Pattern.CASE_INSENSITIVE' : '';
    return `Pattern.compile(${this.quote(body.source)}${suffix})`;
  }

  private toCallWithExact(clazz: string, method: string, body: string | RegExp, exact: boolean) {
    if (isRegExp(body))
      return `${method}(${this.regexToString(body)})`;
    if (exact)
      return `${method}(${this.quote(body)}, new ${clazz}.${toTitleCase(method)}Options().setExact(true))`;
    return `${method}(${this.quote(body)})`;
  }

  private toHasText(body: string | RegExp) {
    if (isRegExp(body))
      return this.regexToString(body);
    return this.quote(body);
  }

  private quote(text: string) {
    return escapeWithQuotes(text, '\"');
  }
}

export class CSharpLocatorFactory implements LocatorFactory {
  generateLocator(base: LocatorBase, kind: LocatorType, body: string | RegExp, options: LocatorOptions = {}): string {
    switch (kind) {
      case 'default':
        return `Locator(${this.quote(body as string)})`;
      case 'frame':
        return `FrameLocator(${this.quote(body as string)})`;
      case 'nth':
        return `Nth(${body})`;
      case 'first':
        return `First`;
      case 'last':
        return `Last`;
      case 'role':
        const attrs: string[] = [];
        if (isRegExp(options.name)) {
          attrs.push(`NameRegex = ${this.regexToString(options.name)}`);
        } else if (typeof options.name === 'string') {
          attrs.push(`Name = ${this.quote(options.name)}`);
          if (options.exact)
            attrs.push(`Exact = true`);
        }
        for (const { name, value } of options.attrs!)
          attrs.push(`${toTitleCase(name)} = ${typeof value === 'string' ? this.quote(value) : value}`);
        const attrString = attrs.length ? `, new() { ${attrs.join(', ')} }` : '';
        return `GetByRole(AriaRole.${toTitleCase(body as string)}${attrString})`;
      case 'has-text':
        return `Filter(new() { ${this.toHasText(body)} })`;
      case 'has':
        return `Filter(new() { Has = ${body} })`;
      case 'or':
        return `Or(${body})`;
      case 'and':
        return `And(${body})`;
      case 'not':
        return `Not(${body})`;
      case 'test-id':
        return `GetByTestId(${this.quote(body as string)})`;
      case 'text':
        return this.toCallWithExact('GetByText', body, !!options.exact);
      case 'alt':
        return this.toCallWithExact('GetByAltText', body, !!options.exact);
      case 'placeholder':
        return this.toCallWithExact('GetByPlaceholder', body, !!options.exact);
      case 'label':
        return this.toCallWithExact('GetByLabel', body, !!options.exact);
      case 'title':
        return this.toCallWithExact('GetByTitle', body, !!options.exact);
      default:
        throw new Error('Unknown selector kind ' + kind);
    }
  }

  private regexToString(body: RegExp): string {
    const suffix = body.flags.includes('i') ? ', RegexOptions.IgnoreCase' : '';
    return `new Regex(${this.quote(body.source)}${suffix})`;
  }

  private toCallWithExact(method: string, body: string | RegExp, exact: boolean) {
    if (isRegExp(body))
      return `${method}(${this.regexToString(body)})`;
    if (exact)
      return `${method}(${this.quote(body)}, new() { Exact = true })`;
    return `${method}(${this.quote(body)})`;
  }

  private toHasText(body: string | RegExp) {
    if (isRegExp(body))
      return `HasTextRegex = ${this.regexToString(body)}`;
    return `HasText = ${this.quote(body)}`;
  }

  private quote(text: string) {
    return escapeWithQuotes(text, '\"');
  }
}

const generators: Record<Language, LocatorFactory> = {
  javascript: new JavaScriptLocatorFactory(),
  python: new PythonLocatorFactory(),
  java: new JavaLocatorFactory(),
  csharp: new CSharpLocatorFactory(),
};

export function isRegExp(obj: any): obj is RegExp {
  return obj instanceof RegExp;
}
