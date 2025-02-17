import translateLoader from '@simon_he/translate'

export const translateApi = translateLoader()

export async function translate(_prefix: string, lan: 'zh' | 'en') {
  let result = (await translateApi(_prefix, lan))[0].trim().replace(/the/gi, '')
  if (result.includes('and')) {
    result = result.split('and')[0]
  }
  // 如果存在 of 则颠倒
  if (result.includes(' of ')) {
    const [A, B] = result.split(' of ')
    result = `${B} ${A}`
  }
  return result.replace(/\s+/g, '-')
}
