import type { Page } from 'playwriter';
import { getAriaSnapshot } from 'playwriter';

export const MAX_PAGE_TEXT_LENGTH = 30000;

export interface ExtractedPageText {
  readonly text: string;
  readonly totalLength: number;
  readonly returnedLength: number;
  readonly truncated: boolean;
}

export interface ExtractedPageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly ariaSnapshot: string;
  readonly truncated: boolean;
}

export interface ExtractedLink {
  readonly text: string;
  readonly href: string;
}

export interface ExtractedFormField {
  readonly name: string;
  readonly type: string;
  readonly label: string;
  readonly value: string;
  readonly required: boolean;
  readonly isPassword: boolean;
}

export interface ExtractedForm {
  readonly id: string;
  readonly action: string;
  readonly method: string;
  readonly fields: ExtractedFormField[];
}

export async function extractPageText(
  page: Page,
  maxLength = MAX_PAGE_TEXT_LENGTH,
): Promise<ExtractedPageText> {
  let rawText: string;
  try {
    rawText = await page.innerText('body');
  } catch {
    rawText = '';
  }

  const clean = rawText.replace(/\r\n/g, '\n').trim();
  const totalLength = clean.length;

  if (totalLength <= maxLength) {
    return {
      text: clean,
      totalLength,
      returnedLength: totalLength,
      truncated: false,
    };
  }

  const truncatedText = clean.slice(0, maxLength);
  return {
    text: truncatedText,
    totalLength,
    returnedLength: maxLength,
    truncated: true,
  };
}

export async function extractPageSnapshot(
  page: Page,
  maxChars = 30000,
): Promise<ExtractedPageSnapshot> {
  const url = page.url();
  let title: string;
  try {
    title = await page.title();
  } catch {
    title = '';
  }

  let snapshotText: string;
  try {
    const result = await getAriaSnapshot({ page });
    snapshotText = result.snapshot;
  } catch {
    try {
      snapshotText = await page.innerText('body');
    } catch {
      snapshotText = '';
    }
  }

  if (snapshotText.length > maxChars) {
    return {
      url,
      title,
      ariaSnapshot: snapshotText.slice(0, maxChars),
      truncated: true,
    };
  }

  return {
    url,
    title,
    ariaSnapshot: snapshotText,
    truncated: false,
  };
}

export async function extractLinks(page: Page): Promise<ExtractedLink[]> {
  const locators = page.locator('a[href]');
  let count: number;
  try {
    count = await locators.count();
  } catch {
    count = 0;
  }
  const links: ExtractedLink[] = [];

  for (let i = 0; i < Math.min(count, 100); i++) {
    const loc = locators.nth(i);
    try {
      const href = await loc.getAttribute('href');
      const text = (await loc.innerText()).trim();
      if (href) {
        links.push({
          text: text ? text : href,
          href,
        });
      }
    } catch {
      // Element may have detached
    }
  }

  return links;
}

export async function extractForms(page: Page): Promise<ExtractedForm[]> {
  const forms = page.locator('form');
  let count: number;
  try {
    count = await forms.count();
  } catch {
    count = 0;
  }
  const results: ExtractedForm[] = [];

  for (let i = 0; i < Math.min(count, 10); i++) {
    const form = forms.nth(i);
    let formId: string;
    let action: string;
    let method: string;

    try {
      formId = (await form.getAttribute('id')) ?? `form-${String(i)}`;
      action = (await form.getAttribute('action')) ?? '';
      method = ((await form.getAttribute('method')) ?? 'GET').toUpperCase();
    } catch {
      formId = `form-${String(i)}`;
      action = '';
      method = 'GET';
    }

    const inputs = form.locator('input, textarea, select');
    let inputCount: number;
    try {
      inputCount = await inputs.count();
    } catch {
      inputCount = 0;
    }
    const fields: ExtractedFormField[] = [];

    for (let j = 0; j < Math.min(inputCount, 50); j++) {
      const input = inputs.nth(j);
      try {
        const name =
          (await input.getAttribute('name')) ??
          (await input.getAttribute('id')) ??
          `field-${String(j)}`;
        const type = (await input.getAttribute('type')) ?? 'text';
        const isPassword = type.toLowerCase() === 'password';
        const required = (await input.getAttribute('required')) !== null;
        let val: string;
        if (isPassword) {
          val = '[REDACTED_PASSWORD]';
        } else {
          try {
            val = await input.inputValue();
          } catch {
            val = '';
          }
        }
        const label =
          (await input.getAttribute('aria-label')) ??
          (await input.getAttribute('placeholder')) ??
          name;

        fields.push({
          name,
          type,
          label,
          value: val,
          required,
          isPassword,
        });
      } catch {
        // Skip detached input
      }
    }

    results.push({
      id: formId,
      action,
      method,
      fields,
    });
  }

  return results;
}

export async function findTextOnPage(
  page: Page,
  query: string,
): Promise<{ found: boolean; count: number; snippets: string[] }> {
  let rawText: string;
  try {
    rawText = await page.innerText('body');
  } catch {
    rawText = '';
  }

  const lowerText = rawText.toLowerCase();
  const lowerQuery = query.toLowerCase();

  const snippets: string[] = [];
  let pos = 0;
  let count = 0;

  while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
    count++;
    if (snippets.length < 5) {
      const start = Math.max(0, pos - 40);
      const end = Math.min(rawText.length, pos + query.length + 40);
      const snippet = rawText.slice(start, end).replace(/\s+/g, ' ').trim();
      snippets.push(`...${snippet}...`);
    }
    pos += query.length;
  }

  return {
    found: count > 0,
    count,
    snippets,
  };
}
