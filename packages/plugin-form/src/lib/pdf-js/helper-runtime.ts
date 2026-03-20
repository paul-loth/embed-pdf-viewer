import {
  PdfWidgetAnnoField,
  PdfWidgetAnnoObject,
  PdfWidgetJavaScriptActionObject,
  PdfJavaScriptWidgetEventType,
  PDF_FORM_FIELD_TYPE,
} from '@embedpdf/models';

type PdfJsPrimitive = string | number | boolean | null | PdfJsPrimitive[];

interface PdfJsFieldState {
  fieldName: string;
  field: PdfWidgetAnnoField;
}

interface PdfJsEventState {
  value: string;
  rc: boolean;
  willCommit: boolean;
  silenceErrors: boolean;
  target: {
    name: string;
  };
}

interface PdfJsExecutionState {
  currentFieldName: string;
  fields: Map<string, PdfJsFieldState>;
  touchedFieldNames: Set<string>;
  unsupportedScripts: string[];
}

interface HelperInvocation {
  name: string;
  args: PdfJsPrimitive[];
}

export interface HelperPdfJsBatchInput {
  widgets: PdfWidgetAnnoObject[];
  currentAnnotationId: string;
  proposedField: PdfWidgetAnnoField;
}

export interface HelperPdfJsBatchActions {
  keystroke: PdfWidgetJavaScriptActionObject[];
  validate: PdfWidgetJavaScriptActionObject[];
  calculate: PdfWidgetJavaScriptActionObject[];
  format: PdfWidgetJavaScriptActionObject[];
}

export interface HelperPdfJsBatchResult {
  accepted: boolean;
  touchedFieldNames: string[];
  fieldStates: Map<string, PdfWidgetAnnoField>;
  unsupportedScripts: string[];
}

const DATE_FORMATS = [
  'm/d',
  'm/d/yy',
  'mm/dd/yy',
  'mm/yy',
  'd-mmm',
  'd-mmm-yy',
  'dd-mmm-yy',
  'yy-mm-dd',
  'mmm-yy',
  'mmmm-yy',
  'mmm d, yyyy',
  'mmmm d, yyyy',
  'm/d/yy h:MM tt',
  'm/d/yy HH:MM',
] as const;

const TIME_FORMATS = ['HH:MM', 'h:MM tt', 'HH:MM:ss', 'h:MM:ss tt'] as const;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const MONTH_NAME_TO_INDEX = new Map<string, number>(
  MONTH_NAMES.flatMap((name, index) => [
    [name.toLowerCase(), index],
    [name.slice(0, 3).toLowerCase(), index],
  ]),
);

export function runHelperPdfJsBatch(
  input: HelperPdfJsBatchInput,
  actions: HelperPdfJsBatchActions,
): HelperPdfJsBatchResult {
  const currentWidget = input.widgets.find((widget) => widget.id === input.currentAnnotationId);
  const currentFieldName = input.proposedField.name || currentWidget?.field.name || '';
  const state = createExecutionState(input.widgets, currentFieldName, input.proposedField);
  const currentFormatActions = actions.format.filter(
    (action) => action.fieldName === currentFieldName,
  );

  const keystrokeAccepted = runPhaseActions(
    state,
    actions.keystroke,
    currentFieldName,
    state.fields.get(currentFieldName)?.field.value ?? '',
    PdfJavaScriptWidgetEventType.Keystroke,
  );
  if (!keystrokeAccepted) {
    return buildBatchResult(state, false);
  }

  const validateAccepted = runPhaseActions(
    state,
    actions.validate,
    currentFieldName,
    state.fields.get(currentFieldName)?.field.value ?? '',
    PdfJavaScriptWidgetEventType.Validate,
  );
  if (!validateAccepted) {
    return buildBatchResult(state, false);
  }

  for (const action of actions.calculate) {
    const targetFieldName = action.fieldName;
    const targetField = state.fields.get(targetFieldName)?.field;
    if (!targetField) continue;
    const accepted = runPhaseActions(
      state,
      [action],
      targetFieldName,
      targetField.value,
      PdfJavaScriptWidgetEventType.Calculate,
    );
    if (!accepted) {
      return buildBatchResult(state, false);
    }
  }

  const formatTargets = new Set<string>([...state.touchedFieldNames, currentFieldName]);
  for (const fieldName of formatTargets) {
    const targetField = state.fields.get(fieldName)?.field;
    if (!targetField) continue;
    const fieldActions =
      fieldName === currentFieldName
        ? currentFormatActions
        : actions.format.filter((action) => action.fieldName === fieldName);
    if (fieldActions.length === 0) continue;

    const accepted = runPhaseActions(
      state,
      fieldActions,
      fieldName,
      targetField.value,
      PdfJavaScriptWidgetEventType.Format,
    );
    if (!accepted) {
      return buildBatchResult(state, false);
    }
  }

  return buildBatchResult(state, true);
}

function buildBatchResult(state: PdfJsExecutionState, accepted: boolean): HelperPdfJsBatchResult {
  const fieldStates = new Map<string, PdfWidgetAnnoField>();
  for (const [fieldName, entry] of state.fields) {
    if (state.touchedFieldNames.has(fieldName)) {
      fieldStates.set(fieldName, cloneField(entry.field));
    }
  }

  return {
    accepted,
    touchedFieldNames: [...state.touchedFieldNames],
    fieldStates,
    unsupportedScripts: [...state.unsupportedScripts],
  };
}

function createExecutionState(
  widgets: PdfWidgetAnnoObject[],
  currentFieldName: string,
  proposedField: PdfWidgetAnnoField,
): PdfJsExecutionState {
  const fields = new Map<string, PdfJsFieldState>();

  for (const widget of widgets) {
    const fieldName = widget.field?.name;
    if (!fieldName || fields.has(fieldName)) continue;
    fields.set(fieldName, {
      fieldName,
      field: cloneField(widget.field),
    });
  }

  if (currentFieldName) {
    fields.set(currentFieldName, {
      fieldName: currentFieldName,
      field: cloneField(proposedField),
    });
  }

  const touchedFieldNames = new Set<string>();
  if (currentFieldName) touchedFieldNames.add(currentFieldName);

  return {
    currentFieldName,
    fields,
    touchedFieldNames,
    unsupportedScripts: [],
  };
}

function runPhaseActions(
  state: PdfJsExecutionState,
  actions: PdfWidgetJavaScriptActionObject[],
  fieldName: string,
  initialValue: string,
  eventType: PdfJavaScriptWidgetEventType,
): boolean {
  if (actions.length === 0) return true;

  const eventState: PdfJsEventState = {
    value: initialValue,
    rc: true,
    willCommit: true,
    silenceErrors: true,
    target: { name: fieldName },
  };

  for (const action of actions) {
    const invocations = parseHelperInvocations(action.script);
    if (!invocations) {
      state.unsupportedScripts.push(action.script);
      continue;
    }

    for (const invocation of invocations) {
      executeInvocation(state, eventState, fieldName, eventType, invocation);
      if (!eventState.rc) return false;
    }
  }

  applyEventValue(state, fieldName, eventState.value, eventType);
  return eventState.rc;
}

function executeInvocation(
  state: PdfJsExecutionState,
  eventState: PdfJsEventState,
  fieldName: string,
  eventType: PdfJavaScriptWidgetEventType,
  invocation: HelperInvocation,
) {
  switch (invocation.name) {
    case 'AFNumber_Format':
      applyNumberFormat(state, eventState, fieldName, invocation.args);
      return;
    case 'AFNumber_Keystroke':
      applyNumberKeystroke(eventState, invocation.args);
      return;
    case 'AFPercent_Format':
      applyPercentFormat(state, eventState, fieldName, invocation.args);
      return;
    case 'AFPercent_Keystroke':
      applyPercentKeystroke(eventState, invocation.args);
      return;
    case 'AFSpecial_Format':
      applySpecialFormat(state, eventState, fieldName, invocation.args);
      return;
    case 'AFSpecial_Keystroke':
      applySpecialKeystroke(eventState, invocation.args);
      return;
    case 'AFDate_Format':
      applyDateFormat(state, eventState, fieldName, invocation.args);
      return;
    case 'AFDate_FormatEx':
      applyDateFormatEx(state, eventState, fieldName, invocation.args);
      return;
    case 'AFDate_Keystroke':
      applyDateKeystroke(eventState, invocation.args);
      return;
    case 'AFDate_KeystrokeEx':
      applyDateKeystrokeEx(eventState, invocation.args);
      return;
    case 'AFTime_Format':
      applyTimeFormat(state, eventState, fieldName, invocation.args);
      return;
    case 'AFTime_FormatEx':
      applyTimeFormatEx(state, eventState, fieldName, invocation.args);
      return;
    case 'AFTime_Keystroke':
      applyTimeKeystroke(eventState);
      return;
    case 'AFTime_KeystrokeEx':
      applyTimeKeystrokeEx(eventState, invocation.args);
      return;
    case 'AFRange_Validate':
      applyRangeValidate(eventState, invocation.args);
      return;
    case 'AFSimple_Calculate':
      applySimpleCalculate(state, eventState, fieldName, invocation.args);
      return;
    default:
      state.unsupportedScripts.push(invocation.name);
      return;
  }
}

function applyEventValue(
  state: PdfJsExecutionState,
  fieldName: string,
  value: string,
  eventType: PdfJavaScriptWidgetEventType,
) {
  const entry = state.fields.get(fieldName);
  if (!entry) return;
  if (
    eventType === PdfJavaScriptWidgetEventType.Validate &&
    !state.touchedFieldNames.has(fieldName)
  ) {
    return;
  }
  entry.field = setFieldValue(entry.field, value);
  state.fields.set(fieldName, entry);
  state.touchedFieldNames.add(fieldName);
}

function applyNumberFormat(
  state: PdfJsExecutionState,
  eventState: PdfJsEventState,
  fieldName: string,
  args: PdfJsPrimitive[],
) {
  const decimals = toInteger(args[0], 0);
  const sepStyle = toInteger(args[1], 0);
  const negativeStyle = toInteger(args[2], 0);
  const currency = toStringArg(args[4], '');
  const prependCurrency = toBoolean(args[5], false);
  const numeric = makeNumber(eventState.value);
  if (numeric === null) {
    eventState.value = '';
    return;
  }

  const sign = numeric < 0 ? -1 : 1;
  const formatted = formatNumber(Math.abs(numeric), decimals, sepStyle);
  let nextValue = formatted;
  const currencyText = currency || '';

  if (prependCurrency && currencyText) {
    nextValue = `${currencyText}${nextValue}`;
  } else if (currencyText) {
    nextValue = `${nextValue}${currencyText}`;
  }

  if (sign < 0) {
    if (negativeStyle === 2 || negativeStyle === 3) {
      nextValue = `(${nextValue})`;
    } else {
      nextValue = `-${nextValue}`;
    }
  }

  eventState.value = nextValue;
  state.touchedFieldNames.add(fieldName);
}

function applyNumberKeystroke(eventState: PdfJsEventState, args: PdfJsPrimitive[]) {
  const sepStyle = toInteger(args[1], 0);
  const normalized = normalizeNumberInput(eventState.value, sepStyle);
  if (normalized === null) {
    eventState.rc = false;
    return;
  }
  if (sepStyle > 1) {
    eventState.value = normalized.replace('.', ',');
  } else {
    eventState.value = normalized;
  }
}

function applyPercentFormat(
  state: PdfJsExecutionState,
  eventState: PdfJsEventState,
  fieldName: string,
  args: PdfJsPrimitive[],
) {
  const decimals = toInteger(args[0], 0);
  const sepStyle = toInteger(args[1], 0);
  const prepend = toBoolean(args[2], false);
  const numeric = makeNumber(eventState.value);
  if (numeric === null) {
    eventState.value = '';
    return;
  }
  const formatted = `${formatNumber(Math.abs(numeric * 100), decimals, sepStyle)}%`;
  eventState.value = prepend ? `%${formatted.slice(0, -1)}` : formatted;
  state.touchedFieldNames.add(fieldName);
}

function applyPercentKeystroke(eventState: PdfJsEventState, args: PdfJsPrimitive[]) {
  applyNumberKeystroke(eventState, [0, args[1] ?? 0]);
}

function applySpecialFormat(
  state: PdfJsExecutionState,
  eventState: PdfJsEventState,
  fieldName: string,
  args: PdfJsPrimitive[],
) {
  const kind = toInteger(args[0], 0);
  const digits = eventState.value.replace(/\D/g, '');
  switch (kind) {
    case 0:
      eventState.value = digits.slice(0, 5);
      break;
    case 1:
      eventState.value = digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5, 9)}` : digits;
      break;
    case 2:
      eventState.value = formatPhone(digits);
      break;
    case 3:
      eventState.value = formatSsn(digits);
      break;
    default:
      break;
  }
  state.touchedFieldNames.add(fieldName);
}

function applySpecialKeystroke(eventState: PdfJsEventState, args: PdfJsPrimitive[]) {
  const kind = toInteger(args[0], 0);
  const digits = eventState.value.replace(/\D/g, '');
  switch (kind) {
    case 0:
      eventState.rc = digits.length <= 5;
      break;
    case 1:
      eventState.rc = digits.length <= 9;
      break;
    case 2:
      eventState.rc = digits.length <= 11;
      break;
    case 3:
      eventState.rc = digits.length <= 9;
      break;
    default:
      eventState.rc = true;
      break;
  }
}

function applyDateFormat(
  state: PdfJsExecutionState,
  eventState: PdfJsEventState,
  fieldName: string,
  args: PdfJsPrimitive[],
) {
  const format = DATE_FORMATS[toInteger(args[0], 0)] ?? DATE_FORMATS[0];
  applyDateFormatWithPattern(state, eventState, fieldName, format);
}

function applyDateFormatEx(
  state: PdfJsExecutionState,
  eventState: PdfJsEventState,
  fieldName: string,
  args: PdfJsPrimitive[],
) {
  applyDateFormatWithPattern(state, eventState, fieldName, toStringArg(args[0], DATE_FORMATS[0]));
}

function applyDateFormatWithPattern(
  state: PdfJsExecutionState,
  eventState: PdfJsEventState,
  fieldName: string,
  format: string,
) {
  if (!eventState.value) return;
  const parsed = parseDateWithFormat(eventState.value, format);
  eventState.value = parsed ? printDate(format, parsed) : '';
  state.touchedFieldNames.add(fieldName);
}

function applyDateKeystroke(eventState: PdfJsEventState, args: PdfJsPrimitive[]) {
  const format = DATE_FORMATS[toInteger(args[0], 0)] ?? DATE_FORMATS[0];
  applyDateKeystrokeEx(eventState, [format]);
}

function applyDateKeystrokeEx(eventState: PdfJsEventState, args: PdfJsPrimitive[]) {
  const format = toStringArg(args[0], DATE_FORMATS[0]);
  if (!eventState.value) return;
  if (!parseDateWithFormat(eventState.value, format)) {
    eventState.rc = false;
  }
}

function applyTimeFormat(
  state: PdfJsExecutionState,
  eventState: PdfJsEventState,
  fieldName: string,
  args: PdfJsPrimitive[],
) {
  const format = TIME_FORMATS[toInteger(args[0], 0)] ?? TIME_FORMATS[0];
  applyTimeFormatWithPattern(state, eventState, fieldName, format);
}

function applyTimeFormatEx(
  state: PdfJsExecutionState,
  eventState: PdfJsEventState,
  fieldName: string,
  args: PdfJsPrimitive[],
) {
  applyTimeFormatWithPattern(state, eventState, fieldName, toStringArg(args[0], TIME_FORMATS[0]));
}

function applyTimeFormatWithPattern(
  state: PdfJsExecutionState,
  eventState: PdfJsEventState,
  fieldName: string,
  format: string,
) {
  if (!eventState.value) return;
  const parsed = parseTime(eventState.value);
  eventState.value = parsed ? printDate(format, parsed) : '';
  state.touchedFieldNames.add(fieldName);
}

function applyTimeKeystroke(eventState: PdfJsEventState) {
  if (!eventState.value) return;
  if (!parseTime(eventState.value)) {
    eventState.rc = false;
  }
}

function applyTimeKeystrokeEx(eventState: PdfJsEventState, args: PdfJsPrimitive[]) {
  const format = toStringArg(args[0], TIME_FORMATS[0]);
  if (!eventState.value) return;
  const parsed = parseTime(eventState.value);
  if (!parsed || !matchesTimeFormat(printDate(format, parsed), format)) {
    eventState.rc = false;
  }
}

function applyRangeValidate(eventState: PdfJsEventState, args: PdfJsPrimitive[]) {
  if (!eventState.value) return;
  const lowerEnabled = toBoolean(args[0], false);
  const lowerBound = toNumber(args[1], Number.NEGATIVE_INFINITY);
  const upperEnabled = toBoolean(args[2], false);
  const upperBound = toNumber(args[3], Number.POSITIVE_INFINITY);
  const numeric = makeNumber(eventState.value);
  if (numeric === null) {
    eventState.rc = false;
    return;
  }
  if ((lowerEnabled && numeric < lowerBound) || (upperEnabled && numeric > upperBound)) {
    eventState.rc = false;
  }
}

function applySimpleCalculate(
  state: PdfJsExecutionState,
  eventState: PdfJsEventState,
  fieldName: string,
  args: PdfJsPrimitive[],
) {
  const operation = toStringArg(args[0], 'SUM').toUpperCase();
  const rawFields = args[1];
  const fieldNames = Array.isArray(rawFields)
    ? rawFields.map((value) => toStringArg(value, '')).filter(Boolean)
    : toStringArg(rawFields, '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

  let result = operation === 'PRD' ? 1 : 0;
  let count = 0;
  for (const name of fieldNames) {
    const value = makeNumber(state.fields.get(name)?.field.value ?? '');
    const numeric = value ?? 0;
    if (count === 0 && (operation === 'MIN' || operation === 'MAX')) {
      result = numeric;
    } else {
      switch (operation) {
        case 'SUM':
        case 'AVG':
          result += numeric;
          break;
        case 'PRD':
          result *= numeric;
          break;
        case 'MIN':
          result = Math.min(result, numeric);
          break;
        case 'MAX':
          result = Math.max(result, numeric);
          break;
      }
    }
    count++;
  }

  if (operation === 'AVG' && count > 0) {
    result /= count;
  }

  eventState.value = ['AVG', 'SUM', 'PRD'].includes(operation)
    ? Number(result.toFixed(6)).toString()
    : result.toString();
  state.touchedFieldNames.add(fieldName);
}

function parseHelperInvocations(script: string): HelperInvocation[] | null {
  const statements = splitTopLevel(script, ';')
    .map((value) => value.trim())
    .filter(Boolean);
  if (statements.length === 0) return null;

  const invocations: HelperInvocation[] = [];
  try {
    for (const statement of statements) {
      const openIndex = statement.indexOf('(');
      const closeIndex = statement.lastIndexOf(')');
      if (openIndex <= 0 || closeIndex <= openIndex) return null;
      const name = statement.slice(0, openIndex).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
      const args = splitTopLevel(statement.slice(openIndex + 1, closeIndex), ',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map(parseLiteral);
      invocations.push({ name, args });
    }
  } catch {
    return null;
  }

  return invocations;
}

function parseLiteral(raw: string): PdfJsPrimitive {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const content = raw.slice(1, -1).trim();
    if (!content) return [];
    return splitTopLevel(content, ',').map((value) => parseLiteral(value.trim()));
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return decodeStringLiteral(raw.slice(1, -1));
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const numeric = Number(raw);
  if (!Number.isNaN(numeric)) return numeric;
  throw new Error(`unsupported literal: ${raw}`);
}

function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const prev = input[index - 1];
    if (quote) {
      current += char;
      if (char === quote && prev !== '\\') {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(') parenDepth++;
    if (char === ')') parenDepth--;
    if (char === '[') bracketDepth++;
    if (char === ']') bracketDepth--;

    if (char === separator && parenDepth === 0 && bracketDepth === 0) {
      parts.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (current) parts.push(current);
  return parts;
}

function decodeStringLiteral(input: string): string {
  return input
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function cloneField(field: PdfWidgetAnnoField): PdfWidgetAnnoField {
  return {
    ...field,
    options:
      'options' in field && field.options
        ? field.options.map((option) => ({ ...option }))
        : undefined,
  } as PdfWidgetAnnoField;
}

function setFieldValue(field: PdfWidgetAnnoField, value: string): PdfWidgetAnnoField {
  switch (field.type) {
    case PDF_FORM_FIELD_TYPE.TEXTFIELD:
    case PDF_FORM_FIELD_TYPE.COMBOBOX:
    case PDF_FORM_FIELD_TYPE.LISTBOX:
    case PDF_FORM_FIELD_TYPE.PUSHBUTTON:
    case PDF_FORM_FIELD_TYPE.SIGNATURE:
    case PDF_FORM_FIELD_TYPE.UNKNOWN:
    case PDF_FORM_FIELD_TYPE.XFA:
    case PDF_FORM_FIELD_TYPE.XFA_CHECKBOX:
    case PDF_FORM_FIELD_TYPE.XFA_COMBOBOX:
    case PDF_FORM_FIELD_TYPE.XFA_IMAGEFIELD:
    case PDF_FORM_FIELD_TYPE.XFA_LISTBOX:
    case PDF_FORM_FIELD_TYPE.XFA_PUSHBUTTON:
    case PDF_FORM_FIELD_TYPE.XFA_SIGNATURE:
    case PDF_FORM_FIELD_TYPE.XFA_TEXTFIELD:
      return { ...field, value };
    case PDF_FORM_FIELD_TYPE.CHECKBOX:
    case PDF_FORM_FIELD_TYPE.RADIOBUTTON:
      return {
        ...field,
        value,
        isChecked: value !== '' && value !== 'Off' && value !== '0' && value !== 'false',
      };
    default:
      return { ...(field as PdfWidgetAnnoField), value };
  }
}

function makeNumber(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const candidate = normalized.replace(/[^0-9,.\-]/g, '');
  if (!candidate) return null;
  const commaCount = (candidate.match(/,/g) ?? []).length;
  const dotCount = (candidate.match(/\./g) ?? []).length;
  let canonical = candidate;

  if (commaCount > 0 && dotCount > 0) {
    canonical =
      candidate.lastIndexOf(',') > candidate.lastIndexOf('.')
        ? candidate.replace(/\./g, '').replace(',', '.')
        : candidate.replace(/,/g, '');
  } else if (commaCount > 0) {
    canonical = candidate.replace(',', '.');
  }

  const numeric = Number(canonical);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeNumberInput(value: string, sepStyle: number): string | null {
  const candidate = value.trim();
  if (!candidate) return '';
  const normalized =
    sepStyle > 1 ? candidate.replace(/\./g, '').replace(',', '.') : candidate.replace(/,/g, '');
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? normalized : null;
}

function formatNumber(value: number, decimals: number, sepStyle: number): string {
  const fixed = value.toFixed(Math.max(0, decimals));
  const [wholePart, fractionPart] = fixed.split('.');
  const useGrouping = sepStyle === 1 || sepStyle === 3;
  const decimalSeparator = sepStyle > 1 ? ',' : '.';
  const groupSeparator = sepStyle > 1 ? '.' : ',';
  const groupedWhole = useGrouping
    ? wholePart.replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator)
    : wholePart;
  return fractionPart ? `${groupedWhole}${decimalSeparator}${fractionPart}` : groupedWhole;
}

function formatPhone(digits: string): string {
  if (digits.length <= 7) {
    return digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3, 7)}` : digits;
  }
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

function formatSsn(digits: string): string {
  if (digits.length <= 3) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 3)}-${digits.slice(3, 5)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 9)}`;
}

function parseDateWithFormat(value: string, format: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const tokenMatchers: Record<string, string> = {
    yyyy: '(?<year>\\d{4})',
    yy: '(?<year>\\d{2,4})',
    mmmm: '(?<monthName>[A-Za-z]+)',
    mmm: '(?<monthName>[A-Za-z]+)',
    mm: '(?<month>\\d{2})',
    m: '(?<month>\\d{1,2})',
    dd: '(?<day>\\d{2})',
    d: '(?<day>\\d{1,2})',
    HH: '(?<hour24>\\d{2})',
    H: '(?<hour24>\\d{1,2})',
    hh: '(?<hour12>\\d{2})',
    h: '(?<hour12>\\d{1,2})',
    MM: '(?<minute>\\d{2})',
    ss: '(?<second>\\d{2})',
    tt: '(?<ampm>am|pm|AM|PM)',
  };

  const tokens = Object.keys(tokenMatchers).sort((left, right) => right.length - left.length);
  let regexSource = '^';
  for (let index = 0; index < format.length; ) {
    const token = tokens.find((candidate) => format.startsWith(candidate, index));
    if (token) {
      regexSource += tokenMatchers[token];
      index += token.length;
      continue;
    }
    regexSource += escapeRegExp(format[index]);
    index++;
  }
  regexSource += '$';

  const match = new RegExp(regexSource).exec(trimmed);
  if (!match?.groups) return null;

  let year = match.groups.year ? Number(match.groups.year) : new Date().getFullYear();
  if (year < 100) {
    year += year >= 50 ? 1900 : 2000;
  }

  const monthIndex = match.groups.monthName
    ? (MONTH_NAME_TO_INDEX.get(match.groups.monthName.toLowerCase()) ?? 0)
    : Math.max(0, Number(match.groups.month ?? '1') - 1);
  const day = Number(match.groups.day ?? '1');
  const minute = Number(match.groups.minute ?? '0');
  const second = Number(match.groups.second ?? '0');
  let hour = Number(match.groups.hour24 ?? match.groups.hour12 ?? '0');

  if (match.groups.hour12) {
    const ampm = (match.groups.ampm ?? 'am').toLowerCase();
    hour = hour % 12;
    if (ampm === 'pm') hour += 12;
  }

  const date = new Date(year, monthIndex, day, hour, minute, second, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return null;
  }

  return date;
}

function parseTime(value: string): Date | null {
  const trimmed = value.trim();
  const patterns = TIME_FORMATS.map((format) => parseDateWithFormat(trimmed, format));
  return patterns.find((date): date is Date => !!date) ?? null;
}

function matchesTimeFormat(value: string, format: string): boolean {
  return printDate(format, parseTime(value) ?? new Date()) === value;
}

function printDate(format: string, date: Date): string {
  const replacements: Array<[string, string]> = [
    ['mmmm', MONTH_NAMES[date.getMonth()]],
    ['mmm', MONTH_NAMES[date.getMonth()].slice(0, 3)],
    ['yyyy', String(date.getFullYear())],
    ['yy', pad(date.getFullYear() % 100)],
    ['mm', pad(date.getMonth() + 1)],
    ['m', String(date.getMonth() + 1)],
    ['dd', pad(date.getDate())],
    ['d', String(date.getDate())],
    ['HH', pad(date.getHours())],
    ['H', String(date.getHours())],
    ['hh', pad(((date.getHours() + 11) % 12) + 1)],
    ['h', String(((date.getHours() + 11) % 12) + 1)],
    ['MM', pad(date.getMinutes())],
    ['ss', pad(date.getSeconds())],
    ['tt', date.getHours() < 12 ? 'am' : 'pm'],
  ];

  let output = format;
  for (const [token, replacement] of replacements) {
    output = output.replace(new RegExp(token, 'g'), replacement);
  }
  return output;
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toInteger(value: PdfJsPrimitive, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function toNumber(value: PdfJsPrimitive, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toBoolean(value: PdfJsPrimitive, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function toStringArg(value: PdfJsPrimitive, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
