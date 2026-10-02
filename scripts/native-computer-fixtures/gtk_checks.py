#!/usr/bin/env python3
"""Actual GTK widget signals and oracle, under disposable Xvfb, not helper acceptance."""
import contextlib, json, os, pathlib, runpy, sys
from check_oracle import validate
import gi
gi.require_version('Gtk','3.0')
from gi.repository import Gtk
ROOT=pathlib.Path(__file__).resolve().parents[2]
FIXTURE=ROOT/'apps/app-desktop/native/computer-control/linux/fixture.py'
CONFIG=json.loads((pathlib.Path(__file__).with_name('tasks.v1.json')).read_text())
original_main=Gtk.main

def all_widgets(w):
    yield w
    if isinstance(w,Gtk.Container):
        for child in w.get_children(): yield from all_widgets(child)

def run(r, output=True, repeats=1, cancel=False, probe_text=None):
    sys.argv=[str(FIXTURE),'--eval-split',r['split'],'--eval-seed',str(r['seed']),'--eval-variant',r['variant']]+(['--eval-oracle-stdout'] if output else [])
    read_fd,write_fd=os.pipe()
    capture=os.fdopen(write_fd,"w",encoding="utf-8")
    def drive():
        window=next(w for w in Gtk.Window.list_toplevels() if w.get_visible())
        widgets=list(all_widgets(window))
        def click(label): next(w for w in widgets if isinstance(w,Gtk.Button) and w.get_label()==label).clicked()
        if r['variant'] in ('form-selection','unicode','menu-dialog','prompt-injection'):
            entry=next(w for w in widgets if isinstance(w,Gtk.Entry));entry.set_text(r['payload'])
        if r['variant'] in ('form-selection','unicode','menu-dialog'):
            choices=next(w for w in widgets if isinstance(w,Gtk.ListBox))
            choices.select_row(next(row for row in choices.get_children() if row.get_child().get_text()==r['choice']))
        if r['variant']=='menu-dialog':
            root=next(w for w in widgets if isinstance(w,Gtk.MenuItem))
            root.get_submenu().get_children()[0].activate()
            click('Review '+r['label'])
            dialog=next(w for w in Gtk.Window.list_toplevels() if isinstance(w,Gtk.Dialog))
            dialog.response(Gtk.ResponseType.CANCEL if cancel else Gtk.ResponseType.OK)
        if r['variant']=='duplicate-labels':
            group=next(w for w in widgets if isinstance(w,Gtk.Frame) and w.get_label()==r['context']+' target');[group.get_child().clicked() for _ in range(repeats)]
        if r['variant']=='approved-mock-effect':

            for _ in range(repeats):
                click('Mock send '+r['label']);click('Mock delete '+r['label'])
        if r['variant']=='canvas':
            from gi.repository import Gdk
            area=next(w for w in widgets if isinstance(w,Gtk.DrawingArea))
            # Real GTK event signals, not OS/helper pixel dispatch.
            for kind,signal in [(Gdk.EventType.BUTTON_PRESS,'button-press-event'),(Gdk.EventType.BUTTON_RELEASE,'button-release-event')]:
                e=Gdk.Event.new(kind);e.button=1;e.x=r['x']+10;e.y=r['y']+10;area.emit(signal,e)
        if probe_text is not None:
            for entry in widgets:
                if isinstance(entry,Gtk.Entry):entry.set_text(probe_text)
    Gtk.main=drive
    with contextlib.redirect_stdout(capture):
        try: runpy.run_path(str(FIXTURE))
        except SystemExit as e: assert e.code==0
    capture.close()
    with os.fdopen(read_fd,"r",encoding="utf-8") as stream: return stream.read()

for r in CONFIG['variants']:
    for output in [True,False]:
        try:
            text=run(r,output)
        finally:
            for w in Gtk.Window.list_toplevels(): w.hide()
        lines=[json.loads(l) for l in text.splitlines()]
        if not output: assert not lines;continue
        assert lines and lines[0]['sequence']==0
        assert all(l['identity']==r['id'] and l['sequence']==i for i,l in enumerate(lines))
        assert lines[-1]['state']==r['postcondition'],(r['id'],lines[-1])
        assert validate([line.encode() for line in text.splitlines(keepends=True)],r)
        assert all(set(l)=={'schema','identity','sequence','state'} for l in lines)
# Independent counters must not collapse duplicate dispatches into success.
for variant, fields in [('duplicate-labels',['duplicateTarget']),('approved-mock-effect',['sends','deletes'])]:
    r=next(r for r in CONFIG['variants'] if r['variant']==variant)
    lines=[json.loads(l) for l in run(r,repeats=2).splitlines()]
    assert all(lines[-1]['state'][k]==2 for k in fields)
    assert lines[-1]['state']!=r['postcondition']
    for w in Gtk.Window.list_toplevels():w.hide()
r=next(r for r in CONFIG['variants'] if r['variant']=='menu-dialog')
lines=[json.loads(l) for l in run(r,cancel=True).splitlines()]
assert lines[-1]['state']['confirms']==0 and lines[-1]['state']['cancels']==1
for w in Gtk.Window.list_toplevels():w.hide()
for variant in ['unicode','secure']:
    r=next(r for r in CONFIG['variants'] if r['variant']==variant)
    text=run(r,probe_text='SYNTHETIC-PRIVATE-PROBE-🦉')
    assert 'PRIVATE-PROBE' not in text and 'SYNTHETIC-NOT-A-SECRET' not in text
    assert all(len(l.encode())<=1024 for l in text.splitlines(keepends=True))
    for w in Gtk.Window.list_toplevels():w.hide()
# Argument failure must precede creation of any evaluation windows.
for args in [[],['--eval-split','train','--eval-seed','3301','--eval-variant','canvas'],['--eval-split','train','--eval-seed','1103','--eval-variant','canvas','--canvas']]:
    sys.argv=[str(FIXTURE),'--eval-oracle-stdout']+args
    try: runpy.run_path(str(FIXTURE));raise AssertionError('accepted invalid args')
    except SystemExit as e: assert e.code!=0
Gtk.main=original_main
print('PASS: 24 GTK evaluation variants, exact postconditions, opt-in output, invalid args')
