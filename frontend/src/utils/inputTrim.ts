/**
 * Input trimming helpers.
 *
 * Goal: whatever the user types into a text field, the value that is displayed
 * and ultimately persisted to the server has no leading/trailing whitespace
 * ("  Hit Me  " -> "Hit Me").
 *
 * This is enforced in two layers so no form (current or future) can slip
 * through and so a value is trimmed even if its field was never blurred:
 *
 *  1. installInputTrimOnBlur() - a single document-level listener that trims
 *     text-like inputs/textareas when they lose focus, so the user immediately
 *     sees the cleaned value. Installed once at app startup.
 *
 *  2. trimStringsDeep() - recursively trims every string in a value. The API
 *     client request interceptor runs this over each request body, so every
 *     payload reaches the server trimmed regardless of how it was built.
 */

/** Input types that hold free-form text the user types into. */
const TRIMMABLE_INPUT_TYPES = new Set([
  'text',
  'email',
  'tel',
  'search',
  'url',
  'password',
]);

/** True when the element is a text-like input or a textarea the user can edit. */
function isTrimmableField(
  el: EventTarget | null,
): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) {
    return !el.readOnly && !el.disabled;
  }
  if (el instanceof HTMLInputElement) {
    return TRIMMABLE_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
  }
  return false;
}

/**
 * Writes a new value into a controlled input/textarea so React notices the
 * change. Setting `.value` directly would be silently overwritten on the next
 * render; going through the prototype's native setter and dispatching an
 * `input` event makes React's onChange fire and keeps component state in sync.
 */
function setFieldValue(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(field, value);
  } else {
    field.value = value;
  }
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

let trimOnBlurInstalled = false;

/**
 * Installs a single global `focusout` listener that trims leading/trailing
 * whitespace from text inputs when they lose focus. Safe to call more than
 * once - the listener is only attached the first time.
 */
export function installInputTrimOnBlur(): void {
  if (trimOnBlurInstalled || typeof document === 'undefined') {
    return;
  }
  trimOnBlurInstalled = true;

  // `focusout` bubbles (unlike `blur`), so one document listener covers every
  // input in the app.
  document.addEventListener('focusout', (event: FocusEvent) => {
    const field = event.target;
    if (!isTrimmableField(field)) {
      return;
    }
    const trimmed = field.value.trim();
    if (trimmed !== field.value) {
      setFieldValue(field, trimmed);
    }
  });
}

/**
 * Recursively trims leading/trailing whitespace from every string contained in
 * `value`. Plain objects and arrays are walked; strings are trimmed; class
 * instances (Date, FormData, ...) and all other types are returned untouched
 * so request bodies such as file uploads are never corrupted.
 */
export function trimStringsDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return value.trim() as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => trimStringsDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        result[key] = trimStringsDeep((value as Record<string, unknown>)[key]);
      }
      return result as T;
    }
  }
  return value;
}
