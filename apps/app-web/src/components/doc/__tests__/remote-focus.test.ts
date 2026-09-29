// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { groupRemoteFocus, initialsOf, remoteCaret } from '../remote-focus';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    list: { group: 'block', content: 'paragraph+' },
    divider: { group: 'block', atom: true },
    text: {},
  },
});

// doc: <p>alpha</p> <list><p>one</p><p>two</p></list> <divider/> <p>omega</p>
const doc = schema.node('doc', null, [
  schema.node('paragraph', null, [schema.text('alpha')]),
  schema.node('list', null, [
    schema.node('paragraph', null, [schema.text('one')]),
    schema.node('paragraph', null, [schema.text('two')]),
  ]),
  schema.node('divider'),
  schema.node('paragraph', null, [schema.text('omega')]),
]);

const ada = { id: 'u-ada', name: 'Ada Example', color: '#3E63DD' };
const bo = { id: 'u-bo', name: 'Bo Example', color: '#E5484D' };

describe('[COMP:app-web/remote-focus] remote presence as a quiet block highlight', () => {
  it('groups peers onto the textblock their cursor is in, deduping one person across tabs', () => {
    const blocks = groupRemoteFocus(doc, [
      { clientId: 2, head: 3, user: ada },
      { clientId: 3, head: 5, user: ada },
      { clientId: 4, head: 2, user: bo },
      { clientId: 5, head: 15, user: bo },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ from: 0, to: 7, textblock: true });
    expect(blocks[0]!.users.map((u) => u.id)).toEqual(['u-ada', 'u-bo']);
    // Inside the list the highlight hugs the line, not the whole list.
    const secondLine = doc.child(1).child(0).nodeSize + 8;
    expect(blocks[1]).toMatchObject({ from: secondLine, textblock: true });
  });

  it('falls back to the top-level block when the head is not in a textblock, and clamps', () => {
    const dividerPos = doc.child(0).nodeSize + doc.child(1).nodeSize;
    const blocks = groupRemoteFocus(doc, [
      { clientId: 2, head: dividerPos, user: { name: 'No id' } },
      { clientId: 3, head: 10_000, user: ada },
    ]);
    expect(blocks.map((b) => b.textblock)).toEqual([false, true]);
    expect(blocks[0]!.users[0]!.id).toBe('client:2');
  });

  it('renders a label-free caret and derives initials', () => {
    const caret = remoteCaret(ada);
    expect(caret.className).toBe('doc-remote-caret');
    expect(caret.title).toBe('Ada Example');
    expect(caret.querySelector('div')).toBeNull();
    expect(caret.textContent).not.toContain('Ada');
    expect(initialsOf('Ada Example')).toBe('AE');
    expect(initialsOf('  ')).toBe('?');
  });
});
