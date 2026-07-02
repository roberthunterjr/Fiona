// SPDX-License-Identifier: Apache-2.0
// Licensed to the Ed-Fi Alliance under one or more agreements.
// The Ed-Fi Alliance licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, it, expect, jest } from '@jest/globals';

jest.unstable_mockModule('../../src/agent/utils/citation-telemetry.js', () => ({
  recordMetadataWaitDuration: jest.fn(),
  recordSourceCount: jest.fn(),
  incrementDegradedNoMetadataCount: jest.fn(),
  incrementTotalResponseCount: jest.fn(),
}));

// Capture the create mock so tests can set their own resolved value.
const mockCreate = jest.fn();

jest.unstable_mockModule('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

// Set the env var BEFORE the dynamic import so the module-level initializer
// picks it up and assigns `perplexityClient`.
process.env.PERPLEXITY_API_KEY = 'test-key';

const { aggregatePerplexityMetadata, callPerplexityChat, callLLM, assertLLMConfigured } = await import(
  '../../src/agent/llm-caller.js'
);

describe('assertLLMConfigured', () => {
  it('does not throw when PERPLEXITY_API_KEY is set at module load', () => {
    expect(() => assertLLMConfigured()).not.toThrow();
  });
});

function makeMetadata() {
  return {
    sources: [],
    source_index_map: Object.create(null),
    search_results: [],
    finalize_state: 'streaming_text',
  };
}

describe('aggregatePerplexityMetadata', () => {
  it('adds all citations as sources', () => {
    const metadata = makeMetadata();
    aggregatePerplexityMetadata(metadata, {
      citations: ['https://a.example.com', 'https://b.example.com'],
    });

    const urls = metadata.sources.map((s) => s.url);
    expect(urls).toContain('https://a.example.com');
    expect(urls).toContain('https://b.example.com');
  });

  it('produces no sources when citations is empty', () => {
    const metadata = makeMetadata();
    aggregatePerplexityMetadata(metadata, { citations: [] });

    expect(metadata.sources).toHaveLength(0);
  });

  it('is a no-op when perplexityResponse is null', () => {
    const metadata = makeMetadata();
    expect(() => aggregatePerplexityMetadata(metadata, null)).not.toThrow();
    expect(metadata.sources).toHaveLength(0);
  });
});

describe('callPerplexityChat – buffer and linkify', () => {
  /**
   * Build a fake async-iterable Perplexity streaming response.
   * Each element may have { text, citations }.
   */
  function makeStream(chunks) {
    return {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next() {
            if (i >= chunks.length) return { done: true, value: undefined };
            const chunk = chunks[i++];
            return {
              done: false,
              value: {
                citations: chunk.citations,
                choices: chunk.text !== undefined ? [{ delta: { content: chunk.text } }] : [],
              },
            };
          },
        };
      },
    };
  }

  function makeStreamer(metadata) {
    const appended = [];
    return {
      __citation_metadata: metadata,
      append: jest.fn(async ({ markdown_text }) => {
        appended.push(markdown_text);
      }),
      _appended: appended,
    };
  }

  it('buffers all text chunks and emits a single linkified append after citations arrive', async () => {
    const metadata = makeMetadata();
    const streamer = makeStreamer(metadata);

    // Simulate: text in two chunks, citations on the last chunk.
    mockCreate.mockResolvedValue(
      makeStream([
        { text: 'See [1] and ' },
        { text: '[2] for details.', citations: ['https://first.example.com', 'https://second.example.com'] },
      ]),
    );

    await callPerplexityChat(streamer, [{ role: 'user', content: 'hello' }]);

    // Should emit exactly one append call containing fully linkified text.
    expect(streamer.append).toHaveBeenCalledTimes(1);
    const emittedText = streamer._appended[0];
    expect(emittedText).toBe(
      'See <https://first.example.com|[1]> and <https://second.example.com|[2]> for details.',
    );
  });

  it('emits the buffered text as-is when no citations are returned', async () => {
    const metadata = makeMetadata();
    const streamer = makeStreamer(metadata);

    mockCreate.mockResolvedValue(makeStream([{ text: 'No citations here.' }, { text: ' Done.' }]));

    await callPerplexityChat(streamer, [{ role: 'user', content: 'hello' }]);

    expect(streamer.append).toHaveBeenCalledTimes(1);
    expect(streamer._appended[0]).toBe('No citations here. Done.');
  });

  it('returns the collected citation URLs', async () => {
    const metadata = makeMetadata();
    const streamer = makeStreamer(metadata);

    mockCreate.mockResolvedValue(
      makeStream([{ text: 'Result [1].', citations: ['https://result.example.com'] }]),
    );

    const { citations } = await callPerplexityChat(streamer, [{ role: 'user', content: 'hello' }]);

    expect(citations).toEqual(['https://result.example.com']);
  });

  it('does not call streamer.append when there is no text', async () => {
    const metadata = makeMetadata();
    const streamer = makeStreamer(metadata);

    // Only a citations chunk, no text delta.
    mockCreate.mockResolvedValue(makeStream([{ citations: ['https://only-citation.example.com'] }]));

    await callPerplexityChat(streamer, [{ role: 'user', content: 'hello' }]);

    expect(streamer.append).not.toHaveBeenCalled();
  });
});

describe('callLLM error path does not mask original failure', () => {
  function makeLogger() {
    return { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  }

  function makeStreamer() {
    return { append: jest.fn().mockResolvedValue(undefined) };
  }

  it('rethrows the original LLM error when metadata is already DEGRADED_NO_METADATA', async () => {
    const llmError = new Error('upstream LLM exploded');
    // First chunk transitions to COLLECTING_METADATA via citations; subsequent
    // throw simulates a streaming failure mid-flight. Then we manually drop
    // the envelope into DEGRADED_NO_METADATA before the throw bubbles up.
    mockCreate.mockImplementation(async () => {
      throw llmError;
    });

    const streamer = makeStreamer();
    // Pre-seed: simulate handleMetadataTimeout having already fired.
    streamer.__citation_metadata = null; // callLLM will overwrite with a fresh envelope

    // Wrap callLLM so we can intercept the envelope and force DEGRADED_NO_METADATA
    // before the catch block runs.  We use a Proxy on the streamer to flip the
    // state the moment callLLM attaches the envelope.
    const captured = {};
    const intercepting = new Proxy(streamer, {
      set(target, prop, value) {
        target[prop] = value;
        if (prop === '__citation_metadata' && value) {
          // Drop into DEGRADED_NO_METADATA via the public state machine.
          value.finalize_state = 'degraded_no_metadata';
          captured.envelope = value;
        }
        return true;
      },
    });

    await expect(callLLM(intercepting, [{ role: 'user', content: 'hi' }], makeLogger())).rejects.toBe(llmError);
    expect(captured.envelope.finalize_state).toBe('degraded_no_metadata');
  });

  it('rethrows the original LLM error when metadata is already READY_TO_FINALIZE', async () => {
    const llmError = new Error('LLM stream aborted');
    mockCreate.mockImplementation(async () => {
      throw llmError;
    });

    const streamer = makeStreamer();
    const captured = {};
    const intercepting = new Proxy(streamer, {
      set(target, prop, value) {
        target[prop] = value;
        if (prop === '__citation_metadata' && value) {
          value.finalize_state = 'ready_to_finalize';
          captured.envelope = value;
        }
        return true;
      },
    });

    await expect(callLLM(intercepting, [{ role: 'user', content: 'hi' }], makeLogger())).rejects.toBe(llmError);
    expect(captured.envelope.finalize_state).toBe('ready_to_finalize');
  });
});

describe('callLLM returns botText alongside metadata', () => {
  it('returns botText alongside the metadata envelope', async () => {
    const fakeStreamer = { append: jest.fn().mockResolvedValue(undefined), stop: jest.fn() };
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        yield { choices: [{ delta: { content: 'Hello world' } }] };
      })(),
    );

    const result = await callLLM(fakeStreamer, [{ role: 'user', content: 'hi' }], { error: jest.fn(), warn: jest.fn(), info: jest.fn() });

    expect(result).toHaveProperty('metadata');
    expect(result).toHaveProperty('botText', 'Hello world');
    expect(result).toHaveProperty('systemPromptVersion', 'v1');
  });
});
