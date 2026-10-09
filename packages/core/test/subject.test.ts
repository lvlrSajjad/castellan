import { describe, expect, it } from 'vitest';
import {
  SUBJECT_TYPE_KEY,
  SubjectTypeError,
  defaultDetectSubjectType,
  resolveSubject,
  subject,
  subjectTypeName,
} from '../src/index.js';

class WorkOrder {}

class Invoice {
  static modelName = 'Bill';
}

const Anonymous = (() => class {})();

describe('subjectTypeName', () => {
  it('returns a string type unchanged', () => {
    expect(subjectTypeName('WorkOrder')).toBe('WorkOrder');
  });

  it('returns a class name', () => {
    expect(subjectTypeName(WorkOrder)).toBe('WorkOrder');
  });

  it('prefers a static modelName over the class name', () => {
    expect(subjectTypeName(Invoice)).toBe('Bill');
  });

  it('throws for anonymous classes', () => {
    expect(() => subjectTypeName(Anonymous)).toThrow(SubjectTypeError);
  });
});

describe('subject', () => {
  it('tags a plain object with the subject type', () => {
    const dto = { id: 1 };
    const tagged = subject('WorkOrder', dto);
    expect(tagged).toBe(dto);
    expect((tagged as Record<string, unknown>)[SUBJECT_TYPE_KEY]).toBe('WorkOrder');
  });

  it('tags with a class, using its modelName when present', () => {
    const dto = subject(Invoice, { id: 1 });
    expect((dto as Record<string, unknown>)[SUBJECT_TYPE_KEY]).toBe('Bill');
  });

  it('does not make the tag enumerable', () => {
    const dto = subject('WorkOrder', { id: 1 });
    expect(Object.keys(dto)).toEqual(['id']);
  });
});

describe('defaultDetectSubjectType', () => {
  it('reads the __type tag first', () => {
    const dto = subject('WorkOrder', { id: 1 });
    expect(defaultDetectSubjectType(dto)).toBe('WorkOrder');
  });

  it('falls back to the constructor name', () => {
    expect(defaultDetectSubjectType(new WorkOrder())).toBe('WorkOrder');
  });

  it('falls back to a static modelName on the constructor', () => {
    expect(defaultDetectSubjectType(new Invoice())).toBe('Bill');
  });

  it('returns undefined for plain objects with no tag', () => {
    expect(defaultDetectSubjectType({ id: 1 })).toBeUndefined();
  });
});

describe('resolveSubject', () => {
  it('resolves a string type with no data', () => {
    expect(resolveSubject('WorkOrder')).toEqual({ type: 'WorkOrder' });
  });

  it('resolves a class type with no data', () => {
    expect(resolveSubject(WorkOrder)).toEqual({ type: 'WorkOrder' });
  });

  it('resolves a tagged plain object, keeping the data', () => {
    const dto = subject('WorkOrder', { id: 1 });
    expect(resolveSubject(dto)).toEqual({ type: 'WorkOrder', data: dto });
  });

  it('resolves a class instance via its constructor name', () => {
    const wo = new WorkOrder();
    expect(resolveSubject(wo)).toEqual({ type: 'WorkOrder', data: wo });
  });

  it('uses a custom detect function when provided', () => {
    const result = resolveSubject({ id: 1 }, () => 'Custom');
    expect(result).toEqual({ type: 'Custom', data: { id: 1 } });
  });

  it('falls back to defaultDetectSubjectType when the custom detector returns undefined', () => {
    const dto = subject('WorkOrder', { id: 1 });
    const result = resolveSubject(dto, () => undefined);
    expect(result).toEqual({ type: 'WorkOrder', data: dto });
  });

  it('throws SubjectTypeError when the type cannot be detected', () => {
    expect(() => resolveSubject({ id: 1 })).toThrow(SubjectTypeError);
  });
});