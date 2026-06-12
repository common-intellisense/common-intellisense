import { describe, expect, it } from 'vitest'
import { componentsReducer, propsReducer } from '../../src/ui/utils'

const headingPattern = /^#{2,4}\s/m

function expectNoLargeMarkdownHeading(value: string | undefined) {
  expect(value).toBeDefined()
  expect(value).not.toMatch(headingPattern)
}

function markdownValue(documentation: any) {
  return typeof documentation === 'string' ? documentation : documentation?.value
}

describe('issue 41 UI markdown formatting', () => {
  it('does not use large markdown headings in hover and completion documentation', async () => {
    const result = await propsReducer({
      uiName: 'fixture',
      lib: '__missing_package__',
      map: [{
        name: 'DemoButton',
        props: {
          disabled: {
            default: 'false',
            value: '',
            type: 'boolean',
            description: 'Disable the button',
          },
        },
        events: [
          { name: 'click', description: 'Click event', params: 'MouseEvent' },
        ],
        methods: [
          { name: 'focus', description: 'Focus button', params: '()' },
        ],
        exposed: [
          { name: 'blur', detail: '()', description: 'Blur button' },
        ],
        slots: [
          { name: 'default', description: 'Default slot' },
        ],
      }],
    })

    const demoButton = result.DemoButton
    const propCompletion = demoButton.completions[0](true).find(item => (item as any).params?.[1] === 'disabled')
    const eventCompletion = demoButton.events[0](true).find(item => (item as any).params?.[1] === 'click')

    expectNoLargeMarkdownHeading(demoButton.tableDocument.value)
    expectNoLargeMarkdownHeading(markdownValue(propCompletion?.documentation))
    expectNoLargeMarkdownHeading(markdownValue(eventCompletion?.documentation))
    expectNoLargeMarkdownHeading(markdownValue(demoButton.methods[0].documentation))
    expectNoLargeMarkdownHeading(markdownValue(demoButton.exposed[0].documentation))
  })

  it('does not use large markdown headings in component completion documentation', async () => {
    const [config] = componentsReducer({
      lib: 'fixture-lib',
      map: [[{ name: 'DemoButton', description: 'Demo button' }, 'Demo detail']],
    })

    const [completion] = await Promise.all(config.data())

    expectNoLargeMarkdownHeading(markdownValue(completion.documentation))
  })
})
