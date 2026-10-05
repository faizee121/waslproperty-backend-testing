import { beforeEach, describe, expect, it, vi } from 'vitest';

const { chatMock, getAiProviderMock } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  getAiProviderMock: vi.fn(),
}));

vi.mock('../../src/modules/ai/providers/provider-factory.js', () => ({
  getAiProvider: getAiProviderMock,
}));

const { interpretStrataPlan, InterpretationFailedError, InterpretationUnavailableError } =
  await import('../../src/modules/property-documents/nsw-strata-plan/interpreter.js');

const validJson = JSON.stringify({
  planNumber: { value: 'SP64555', pageNumber: 1 },
  schemeName: { value: null, pageNumber: null },
  locality: { value: 'Merewether', pageNumber: 1 },
  lga: { value: 'Newcastle', pageNumber: 1 },
  county: { value: 'Northumberland', pageNumber: 1 },
  address: { value: null, pageNumber: null },
  sourceLot: { value: '1', pageNumber: 1 },
  sourceDepositedPlan: { value: 'DP 1003505', pageNumber: 1 },
  registrationDate: { value: '19-12-2000', pageNumber: 1 },
  declaredTotal: { value: 1000, pageNumber: 1 },
  lots: [{ lotNumber: '1', unitsOfEntitlement: 144, pageNumber: 1 }],
  physicalStructureNotes: [],
  commonPropertyNotes: [],
});

const pages = [
  {
    pageNumber: 1,
    text: 'STRATA PLAN SP64555 SCHEDULE OF UNIT ENTITLEMENT',
    confidence: 0.6,
    method: 'OCR' as const,
  },
];

describe('interpretStrataPlan', () => {
  beforeEach(() => {
    chatMock.mockReset();
    getAiProviderMock.mockReset();
    getAiProviderMock.mockReturnValue({ name: 'deepseek', model: 'test-model', chat: chatMock });
  });

  it('parses a valid structured response on the first attempt', async () => {
    chatMock.mockResolvedValueOnce({
      message: { role: 'assistant', content: validJson },
      finishReason: 'stop',
    });
    const result = await interpretStrataPlan(pages);
    expect(result.planNumber.value).toBe('SP64555');
    expect(result.lots).toHaveLength(1);
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('retries once on malformed output and succeeds if the retry is valid', async () => {
    chatMock
      .mockResolvedValueOnce({
        message: { role: 'assistant', content: 'not json at all' },
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        message: { role: 'assistant', content: validJson },
        finishReason: 'stop',
      });
    const result = await interpretStrataPlan(pages);
    expect(result.planNumber.value).toBe('SP64555');
    expect(chatMock).toHaveBeenCalledTimes(2);
  });

  it('throws InterpretationFailedError rather than persisting malformed output as authoritative', async () => {
    chatMock.mockResolvedValue({
      message: { role: 'assistant', content: 'still not json' },
      finishReason: 'stop',
    });
    await expect(interpretStrataPlan(pages)).rejects.toBeInstanceOf(InterpretationFailedError);
    expect(chatMock).toHaveBeenCalledTimes(2); // bounded retry, never unbounded
  });

  it('throws InterpretationUnavailableError when no AI provider is configured', async () => {
    getAiProviderMock.mockReturnValue(null);
    await expect(interpretStrataPlan(pages)).rejects.toBeInstanceOf(InterpretationUnavailableError);
    expect(chatMock).not.toHaveBeenCalled();
  });
});
