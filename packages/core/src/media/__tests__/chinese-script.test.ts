import { describe, it, expect } from 'vitest'
import { convertChineseScript, containsHan } from '../chinese-script.js'
import { parseTranscriptionPrefs } from '../transcription-prefs.js'

describe('[COMP:media/chinese-script] Chinese script conversion', () => {
  it('converts Simplified to Traditional (HK variant), including one-to-many mappings', async () => {
    const [out] = await convertChineseScript(['我觉得内容是最浪费时间的东西，发型也是。'], 'traditional')
    expect(out).toBe('我覺得內容是最浪費時間的東西，髮型也是。')
  })

  it('leaves code-switched English and non-Han characters byte-identical', async () => {
    const input = 'Speaker 1: 你一定要有个 all-in-one system，OK？ [0:13:37]'
    const [out] = await convertChineseScript([input], 'traditional')
    expect(out).toBe('Speaker 1: 你一定要有個 all-in-one system，OK？ [0:13:37]')
  })

  it('returns the input array untouched when no string carries Han characters', async () => {
    const input = ['pure English utterance.', 'numbers 123 & emoji 🎉']
    const out = await convertChineseScript(input, 'traditional')
    expect(out).toBe(input) // same reference — the converter is never loaded
  })

  it('keeps output index-aligned, converting only the Han-bearing strings', async () => {
    const out = await convertChineseScript(['plain', '简体转繁體', 'still plain'], 'traditional')
    expect(out).toEqual(['plain', '簡體轉繁體', 'still plain'])
  })

  it('converts Traditional to Simplified when target is simplified', async () => {
    const [out] = await convertChineseScript(['我覺得內容最浪費時間'], 'simplified')
    expect(out).toBe('我觉得内容最浪费时间')
  })

  it('containsHan discriminates Han from Latin/kana', () => {
    expect(containsHan('广东话')).toBe(true)
    expect(containsHan('English only')).toBe(false)
    expect(containsHan('カタカナ')).toBe(false)
  })
})

describe('[COMP:media/chinese-script] parseTranscriptionPrefs', () => {
  it('accepts a valid prefs object', () => {
    expect(parseTranscriptionPrefs({ languageCode: 'yue', chineseScript: 'traditional' })).toEqual({
      languageCode: 'yue',
      chineseScript: 'traditional',
    })
  })

  it('yields {} for malformed content instead of throwing', () => {
    expect(parseTranscriptionPrefs(null)).toEqual({})
    expect(parseTranscriptionPrefs('traditional')).toEqual({})
    expect(parseTranscriptionPrefs({ languageCode: 'Cantonese (HK)' })).toEqual({})
    expect(parseTranscriptionPrefs({ chineseScript: 'kanji' })).toEqual({})
  })

  it('drops unknown keys', () => {
    expect(parseTranscriptionPrefs({ chineseScript: 'simplified', bogus: 1 })).toEqual({
      chineseScript: 'simplified',
    })
  })
})
