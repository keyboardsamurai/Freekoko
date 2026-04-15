import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { fetchTTS, fetchVoices, SidecarHttpError } from './SidecarClient';

function makeResponse(
  body: BodyInit | null,
  opts: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(body, {
    status: opts.status ?? 200,
    headers: opts.headers,
  });
}

describe('SidecarClient.fetchTTS', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts JSON to /tts and returns wavBuffer + headers', async () => {
    const wav = new Uint8Array([1, 2, 3, 4]);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse(wav, {
        headers: {
          'content-type': 'audio/wav',
          'x-freekoko-voice': 'af_heart',
          'x-freekoko-duration-ms': '123',
          'x-freekoko-sample-count': '48000',
        },
      })
    );

    const res = await fetchTTS(5002, { text: 'hi', voice: 'af_heart', speed: 1.0 });

    expect(fetch).toHaveBeenCalledTimes(1);
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('http://127.0.0.1:5002/tts');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(call[1].body)).toEqual({
      text: 'hi',
      voice: 'af_heart',
      speed: 1.0,
    });
    expect(res.wavBuffer.length).toBe(4);
    expect(res.sampleCount).toBe(48000);
    expect(res.voice).toBe('af_heart');
    expect(res.durationMs).toBeGreaterThan(0);
  });

  it('throws SidecarHttpError with the parsed error code on non-2xx', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse(
        JSON.stringify({
          error: 'voice_not_found',
          message: "Voice 'zz_nope' is not available.",
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    await expect(
      fetchTTS(5002, { text: 'hi', voice: 'zz_nope', speed: 1.0 })
    ).rejects.toMatchObject({
      name: 'SidecarHttpError',
      code: 'voice_not_found',
      status: 400,
    });
  });

  it('falls back to wall-clock duration when header is absent', async () => {
    const wav = new Uint8Array([0, 0, 0, 0]);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse(wav, { headers: { 'content-type': 'audio/wav' } })
    );
    const res = await fetchTTS(5002, { text: 'hi', voice: 'v', speed: 1 });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(res.voice).toBe('v'); // fallback to request voice
  });

  it('wraps generic non-JSON error bodies as SidecarHttpError', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse('oops', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      })
    );
    try {
      await fetchTTS(5002, { text: 'hi', voice: 'v', speed: 1 });
      expect.unreachable('fetchTTS should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SidecarHttpError);
      expect((err as SidecarHttpError).status).toBe(500);
    }
  });
});

describe('SidecarClient.fetchVoices', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses flat array responses and maps languageName', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse(
        JSON.stringify([
          {
            id: 'af_heart',
            name: 'Heart',
            language: 'en-US',
            gender: 'Female',
            quality: 'A',
            available: true,
          },
          {
            id: 'bm_george',
            name: 'George',
            language: 'en-GB',
            gender: 'Male',
            quality: 'B',
            available: true,
          },
        ]),
        { headers: { 'content-type': 'application/json' } }
      )
    );
    const voices = await fetchVoices(5002);
    expect(voices).toHaveLength(2);
    expect(voices[0]).toEqual({
      id: 'af_heart',
      name: 'Heart',
      language: 'en-US',
      languageName: 'American English',
      gender: 'Female',
      quality: 'A',
    });
  });

  it('tolerates a { voices: [...] } envelope shape', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse(
        JSON.stringify({
          voices: [
            {
              id: 'af_heart',
              name: 'Heart',
              language: 'en-US',
              gender: 'Female',
              quality: 'A',
            },
          ],
          total: 1,
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    );
    const voices = await fetchVoices(5002);
    expect(voices).toHaveLength(1);
    expect(voices[0].id).toBe('af_heart');
  });

  it('throws SidecarHttpError on HTTP error', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse(
        JSON.stringify({ error: 'model_not_loaded', message: 'loading' }),
        { status: 503, headers: { 'content-type': 'application/json' } }
      )
    );
    await expect(fetchVoices(5002)).rejects.toMatchObject({
      name: 'SidecarHttpError',
      code: 'model_not_loaded',
      status: 503,
    });
  });
});
