"""Bounded AT-SPI2 inspection and narrow GTK semantic action cohort."""
import os
import math
import time
from pathlib import Path
from contract import native_api_timing, uid, mono, utf16_prefix, AX_TEXT_UNITS, ROLE_UNITS
from safety import process_key, ordinary_credentials
from x11 import X11

FIXTURE = 'com.usebrian.NativeComputerFixture'
EDITOR = 'org.gnome.gedit'
# Audited identities only. Nix's launcher execs this exact ELF; never trust an
# arbitrary store path, similarly named wrapper, argv or window title.
GEDIT_EXECUTABLES = frozenset({
    '/usr/bin/gedit',
    '/nix/store/pbdrndbn9wfzl5j9dhyyykiacrgyia9l-gedit-50.0/bin/.gedit-wrapped',
})
FIXTURE_PATH = Path(__file__).with_name('fixture.py').resolve()
SAFE_ROLES = {'frame', 'panel', 'filler', 'button', 'list box', 'push button', 'check box', 'radio button',
              'text', 'entry', 'label', 'scroll pane', 'scroll bar', 'viewport',
              'list', 'list item', 'table', 'table cell', 'page tab', 'page tab list',
              'split pane', 'separator', 'tool bar', 'menu bar', 'menu', 'menu item',
              'combo box', 'document text', 'section', 'status bar'}


def limited(value, units):
    return utf16_prefix(value, units)


class Backend:
    def __init__(self):
        ordinary_credentials()
        import pyatspi
        self.a = pyatspi
        self.x = X11()
        self.desktop = pyatspi.Registry.getDesktop(0)
        self.windows = {}
        self.processes = {}
        # Bound synchronous AT-SPI method calls too (watchdog remains independent).
        try:
            from gi.repository import Atspi
            Atspi.set_timeout(200, 400)
        except (ImportError, AttributeError):
            raise RuntimeError('AT-SPI timeout support required')

    def cohort(self, pid):
        try:
            ordinary_credentials(pid)
        except RuntimeError:
            return None
        proc = Path(f'/proc/{pid}')
        if proc.stat().st_uid != os.getuid():
            return None
        executable = (proc / 'exe').resolve(strict=True)
        args = (proc / 'cmdline').read_bytes().split(b'\0')
        if str(executable) in GEDIT_EXECUTABLES:
            # Only gedit, not GNOME Text Editor, terminals or generic GTK apps.
            return EDITOR
        if executable.name.startswith('python3') and len(args) >= 2:
            while len(args) > 1 and args[1] in (b'-E', b'-s', b'-Es'):
                args.pop(1)
            # Fixed shipped script, not a caller-selected application/title.
            if os.fsdecode(args[1]) == str(FIXTURE_PATH):
                return FIXTURE
        return None

    def bounds(self, element):
        r = element.queryComponent().getExtents(self.a.DESKTOP_COORDS)
        if not (0 < r.width <= 32768 and 0 < r.height <= 32768):
            raise RuntimeError('invalid bounds')
        return dict(x=r.x, y=r.y, width=r.width, height=r.height)

    def pump(self):
        from gi.repository import GLib
        context = GLib.MainContext.default()
        end = mono() + 20
        while context.pending() and mono() < end:
            context.iteration(False)

    def discover(self):
        self.pump()
        self.desktop.clear_cache()
        next_windows = {}
        started = mono()
        for app_index in range(min(self.desktop.childCount, 128)):
            app = self.desktop.getChildAtIndex(app_index)
            if mono() - started > 1000:
                break
            try:
                pid = app.get_process_id()
                cohort = self.cohort(pid)
                if not cohort:
                    continue
                key = process_key(pid)
                instance = self.processes.setdefault(key, uid())
                for window_index in range(min(app.childCount, 32)):
                    window = app.getChildAtIndex(window_index)
                    if window.getRoleName() != 'frame' or not window.getState().contains(self.a.STATE_SHOWING):
                        continue
                    b = self.bounds(window)
                    xid = self.x.match(pid, b)
                    if not xid:
                        continue
                    old = next((w for w in self.windows.values() if w['key'] == key and w['element'] == window and w['xid'] == xid), None)
                    target = old['target'] if old else dict(appId=cohort, processId=pid, processInstanceId=instance, windowId=uid(), windowInstanceId=uid())
                    next_windows[target['windowInstanceId']] = dict(target=target, element=window, app=app, key=key, xid=xid)
                    if len(next_windows) >= 128:
                        break
            except Exception:
                continue
        self.windows = next_windows
        result = []
        for w in self.windows.values():
            discovered = dict(w['target'])
            try:
                discovered['displayName'] = limited(w['element'].name or '', 256)
            except Exception:
                pass  # Optional local metadata must not hide an otherwise valid target.
            result.append(discovered)
        return result

    def live(self, target):
        self.pump()
        w = self.windows.get(target['windowInstanceId'])
        if not w or w['target'] != target:
            raise RuntimeError('unknown target')
        if process_key(target['processId']) != w['key'] or self.cohort(target['processId']) != target['appId']:
            raise RuntimeError('process changed')
        if w['element'].getRoleName() != 'frame' or w['element'].parent != w['app']:
            raise RuntimeError('window changed')
        w['element'].clear_cache()
        states = w['element'].getState()
        if states.contains(self.a.STATE_DEFUNCT) or not states.contains(self.a.STATE_SHOWING):
            raise RuntimeError('window unavailable')
        b = self.bounds(w['element'])
        if self.x.match(target['processId'], b) != w['xid']:
            raise RuntimeError('window identity changed')
        return w

    def context(self, w):
        self.live(w['target'])
        return dict(bounds=self.bounds(w['element']), displayLayoutVersion=self.x.layout(), foreground=self.x.foreground() == w['xid'])

    def node(self, element, ref, parent, cohort):
        element.clear_cache()
        role = element.getRoleName()
        states = element.getState()
        attrs = element.getAttributes()
        attrs = ' '.join(attrs).lower()
        # Observed passive GTK chrome in the pinned gedit package. These roles
        # never gain actions; unknown roles and sensitive attributes still redact.
        safe_role = role in SAFE_ROLES or (cohort == EDITOR and role in {'toggle button', 'table column header', 'icon', 'tree table'})
        sensitive = not safe_role or any(word in attrs for word in ('password', 'secret', 'sensitive', 'protected'))
        enabled = states.contains(self.a.STATE_ENABLED) and states.contains(self.a.STATE_SENSITIVE)
        interfaces = element.get_interfaces()
        actions = []
        value = None
        complete = True
        name = '' if sensitive else (element.name or '')
        if not sensitive:
            if 'Text' in interfaces:
                txt = element.queryText()
                # Pinned GTK clamps a bounded end offset beyond EOF (native
                # evidence: tests/native_text_bounds.py). Read one sentinel code
                # point beyond the wire bound, then fetch the CURRENT count.
                # Growth/shrink across these calls or a truncated prefix cannot
                # be complete. Never use -1 or fall back to an unbounded read.
                value = txt.getText(0, AX_TEXT_UNITS + 1)
                count = txt.characterCount
                if count < 0:
                    raise ValueError('unknown text length')
                # AT-SPI counts code points. UTF-16/scalar clipping below still
                # independently marks astral/combining/name truncation partial.
                complete = count <= AX_TEXT_UNITS and len(value) == count
            if enabled and states.contains(self.a.STATE_SHOWING):
                if 'EditableText' in interfaces and role in ('text', 'entry') and states.contains(self.a.STATE_EDITABLE):
                    # gedit document text only: single-line search/location fields denied.
                    if cohort == FIXTURE or (cohort == EDITOR and role == 'text' and states.contains(self.a.STATE_MULTI_LINE)):
                        actions.append('setValue')
                if cohort == FIXTURE and role in ('button', 'push button', 'check box', 'radio button', 'menu', 'menu item') and 'Action' in interfaces:
                    action = element.queryAction()
                    if action.nActions == 1 and action.getName(0) in ('click', 'activate', 'toggle'):
                        actions.append('invoke')
                if cohort == FIXTURE and role == 'scroll bar' and 'Value' in interfaces and states.contains(self.a.STATE_VERTICAL):
                    actions.append('scroll')
                if cohort == FIXTURE and role == 'list item' and element.parent and 'Selection' in element.parent.get_interfaces():
                    actions.append('select')
        if not sensitive and role == 'scroll bar' and 'Value' in interfaces:
            value = str(element.queryValue().currentValue)
        n = dict(ref=ref, role=limited(role, ROLE_UNITS), name=limited(name, AX_TEXT_UNITS),
                 enabled=enabled, focused=states.contains(self.a.STATE_FOCUSED),
                 selected=states.contains(self.a.STATE_SELECTED), sensitive=sensitive, actions=actions)
        if parent:
            n['parentRef'] = parent
        if value is not None:
            n['value'] = limited(value, AX_TEXT_UNITS)
        try:
            n['bounds'] = self.bounds(element)
        except Exception:
            pass
        complete = complete and n['role'] == role and n['name'] == name
        if value is not None:
            complete = complete and n['value'] == value
        return n, complete

    def tree(self, w):
        nodes, refs, queue, seen = [], {}, [(w['element'], None, 0)], set()
        started, size, complete = mono(), 0, True
        live_parents = {}
        # The measured gedit tree has ~230 nodes and takes ~1.2s with fresh
        # AT-SPI reads. Keep all structural/size fences; do not skip hidden chrome.
        # The independent production request watchdog is unchanged and may refuse
        # expensive approvals. Native tests do not establish production timing.
        budget_ms = 1800 if w['target']['appId'] == EDITOR else 300
        while queue:
            if len(nodes) >= 500 or mono() - started > budget_ms or size > 350000:
                complete = False
                break
            element, parent, depth = queue.pop(0)
            # Hashable remote accessible handles include bus/path, not display labels.
            if element in seen:
                complete = False
                continue
            seen.add(element)
            ref = uid()
            try:
                n, node_complete = self.node(element, ref, parent, w['target']['appId'])
                complete = complete and node_complete
                if element != w['element']:
                    live_parents[ref] = element.parent
                children = []
                if n['sensitive']:
                    complete = False
                elif depth >= 16:
                    complete = complete and element.childCount == 0
                else:
                    count = element.childCount
                    complete = complete and count <= 500
                    children = [element.getChildAtIndex(i) for i in range(min(count, 500))]
                    queue.extend((c, ref, depth + 1) for c in children if c is not None)
                if len(queue) > 1000:
                    complete = False
                    queue = []
                nodes.append(n)
                refs[ref] = (element, n, children)
                size += len(str(n).encode())
                complete = complete and size <= 350000
            except Exception:
                complete = False
        # GTK may enumerate popovers under the frame while parenting them to
        # relative widgets/menus not present in that enumeration. Close the
        # parent graph BEFORE reading any extra node's content. Every ancestor
        # must provably reach this exact window, within the existing node/depth
        # and time budgets; no missing parent is excused or guessed.
        if complete:
            parent_of = {refs[r][0]: p for r, p in live_parents.items()}
            known = {entry[0] for entry in refs.values()}
            pending = list(parent_of.values())
            while pending and complete:
                extras = []
                while pending and complete:
                    element = pending.pop()
                    if element in known:
                        continue
                    if element is None or len(known) >= 500 or mono()-started > budget_ms:
                        complete = False
                        break
                    known.add(element)
                    element.clear_cache()
                    parent_of[element] = element.parent
                    pending.append(parent_of[element])
                    extras.append(element)
                depths = self._parent_links_rooted(w['element'], parent_of, with_depths=True)
                complete = complete and bool(depths)
                if not complete:
                    break
                for element in sorted(extras, key=depths.__getitem__):
                    if not complete:
                        break
                    if mono()-started > budget_ms or size > 350000:
                        complete = False
                        break
                    ref = uid()
                    n, node_complete = self.node(element, ref, None, w['target']['appId'])
                    if n['sensitive']:
                        # A virtual ancestor can govern nodes enumerated directly
                        # by the window. Never export those descendants' content.
                        def beneath(candidate):
                            while candidate in parent_of:
                                candidate = parent_of[candidate]
                                if candidate == element:
                                    return True
                            return False
                        removed = {r for r, (e, _, _) in refs.items() if beneath(e)}
                        nodes[:] = [node for node in nodes if node['ref'] not in removed]
                        for r in removed:
                            del refs[r]
                            live_parents.pop(r, None)
                        nodes.append(n)
                        refs[ref] = (element, n, [])
                        live_parents[ref] = parent_of[element]
                        complete = False
                        break
                    count = element.childCount
                    if count > 500:
                        complete = False
                        break
                    children = [element.getChildAtIndex(i) for i in range(count)]
                    if element.parent != parent_of[element]:
                        complete = False
                    live_parents[ref] = parent_of[element]
                    nodes.append(n)
                    refs[ref] = (element, n, children)
                    size += len(str(n).encode())
                    complete = complete and node_complete and not n['sensitive'] and size <= 350000
                    # Any newly exposed child must undergo the SAME rooted
                    # parent proof before its contents can enter this snapshot.
                    pending.extend(child for child in children if child not in known)
        by_element = {element: ref for ref, (element, _, _) in refs.items()}
        for ref, parent in live_parents.items():
            parent_ref = by_element.get(parent)
            if parent_ref is None:
                complete = False
            else:
                refs[ref][1]['parentRef'] = parent_ref
        size = sum(len(str(node).encode()) for node in nodes)
        complete = complete and size <= 350000 and self._rooted_refs(w, refs) and mono()-started <= budget_ms
        return nodes, refs, 'complete' if complete else 'partial'

    @staticmethod
    def _parent_links_rooted(root, parents, with_depths=False):
        depths = {root: 0}
        for element in parents:
            trail, seen = [], set()
            current = element
            while current not in depths:
                if current in seen or current not in parents or len(trail) >= 17:
                    return False
                seen.add(current)
                trail.append(current)
                current = parents[current]
            depth = depths[current]
            for child in reversed(trail):
                depth += 1
                if depth > 17:
                    return False
                depths[child] = depth
        return depths if with_depths else True

    def _rooted_refs(self, w, refs):
        """Validate BOTH original graphs locally; never infer a live parent."""
        try:
            if not isinstance(refs, dict) or not 1 <= len(refs) <= 500:
                return False
            by_element, roots = {}, []
            enumerated = {}
            for ref, (element, node, children) in refs.items():
                if not isinstance(ref, str) or not 1 <= len(ref) <= 256 or node['ref'] != ref or node['sensitive'] or element in by_element:
                    return False
                if not isinstance(children, (list, tuple)) or len(children) > 500:
                    return False
                by_element[element] = ref
                if 'parentRef' not in node:
                    roots.append(ref)
                elif node['parentRef'] not in refs:
                    return False
            if len(roots) != 1 or refs[roots[0]][0] != w['element']:
                return False
            for ref, (_, _, children) in refs.items():
                enumerated[ref] = [by_element[child] for child in children]
            if not self._parent_links_rooted(roots[0], {
                    ref: node['parentRef'] for ref, (_, node, _) in refs.items() if 'parentRef' in node}):
                return False
            # Enumeration can be a DAG (GTK virtual parents), but never cyclic,
            # duplicate within one child list, missing a node, or unbounded.
            if sum(map(len, enumerated.values())) > 1000:
                return False
            incoming = {ref: 0 for ref in refs}
            for children in enumerated.values():
                if len(children) != len(set(children)):
                    return False
                for child in children:
                    incoming[child] += 1
            if incoming[roots[0]]:
                return False
            queue = [ref for ref, count in incoming.items() if count == 0]
            depths = {ref: 0 for ref in queue}
            visited = 0
            while queue:
                ref = queue.pop()
                visited += 1
                for child in enumerated[ref]:
                    depths[child] = max(depths.get(child, 0), depths[ref]+1)
                    if depths[child] > 16:
                        return False
                    incoming[child] -= 1
                    if incoming[child] == 0:
                        queue.append(child)
            if visited != len(refs):
                return False
            return True
        except Exception:
            return False

    def unchanged(self, w, refs, ignore_focus=False):
        # Original rooted graphs + immediate LIVE parents + exact LIVE child
        # lists prove unchanged reachability in O(nodes + edges), not O(n*depth).
        try:
            if not self._rooted_refs(w, refs):
                return False
            # live() verifies root -> application, process and native window.
            self.live(w['target'])
            for ref, (element, node, children) in refs.items():
                current_node, complete = self.node(element, ref, node.get('parentRef'), w['target']['appId'])
                if not complete:
                    return False
                if ignore_focus:
                    current_node['focused'] = node['focused']
                if current_node != node:
                    return False
                parent_ref = node.get('parentRef')
                # node() clears the accessible cache before these LIVE reads.
                if parent_ref is not None and element.parent != refs[parent_ref][0]:
                    return False
                if element.childCount != len(children) or any(element.getChildAtIndex(i) != c for i, c in enumerate(children)):
                    return False
            return True
        except Exception:
            return False

    def restore_consented_focus(self, w, refs, context, parent_pid, guard, strict_after=True):
        """Lifecycle-only focus restoration. Caller is the trusted local broker.

        No new ref/window is selected. Full content/structure must survive the
        dialog; only transient focused-state bits may differ before restoration.
        """
        def validate(ignore_focus):
            guard()
            self.live(w['target'])
            actual = self.context(w)
            if any(actual[k] != context[k] for k in ('bounds', 'displayLayoutVersion')):
                raise ValueError('geometry changed before/after focus')
            if not self.unchanged(w, refs, ignore_focus=ignore_focus):
                raise ValueError('tree changed before/after focus')
            guard()
            return actual

        validate(True)
        foreground = self.x.foreground()
        parent_window = foreground if foreground and self.x.pid(foreground) == parent_pid else 0
        if foreground != w['xid'] and not parent_window:
            raise ValueError('focus left the trusted consent parent')
        if not self.x.unoccluded(w['xid'], allowed_window=parent_window):
            raise ValueError('unrelated overlay before focus')
        # Drain consent-dialog input and close its exception BEFORE the EWMH
        # request. No raw input is generated or excepted during focus restoration.
        guard()
        if foreground != w['xid']:
            self.x.request_activation(w['xid'])
        end = mono() + 600
        while self.x.foreground() != w['xid']:
            guard()
            self.live(w['target'])
            if mono() >= end:
                raise ValueError('window manager refused focus')
            time.sleep(.01)
        validate(not strict_after)
        if self.x.foreground() != w['xid'] or not self.x.unoccluded(w['xid']):
            raise ValueError('overlay/focus changed after restoration')
        guard()
        return True

    def act(self, kind, ref, action, guard):
        element = ref[0]
        if kind == 'setValue':
            editable = element.queryEditableText()
            guard()
            with native_api_timing(kind):
                return editable.setTextContents(action['text'])
        if kind == 'invoke':
            invokable = element.queryAction()
            guard()
            with native_api_timing(kind):
                return invokable.doAction(0)
        if kind == 'scroll':
            delta = action['deltaY']
            if type(delta) is not int or not -600 <= delta <= 600:
                raise ValueError('invalid scroll')
            value = element.queryValue()
            current, minimum, maximum = value.currentValue, value.minimumValue, value.maximumValue
            if not all(math.isfinite(v) for v in (current, minimum, maximum)) or not minimum <= current <= maximum:
                raise ValueError('invalid accessible scroll range')
            guard()
            with native_api_timing(kind):
                value.currentValue = max(minimum, min(maximum, current + delta))
            return True
        if kind == 'select':
            selection = element.parent.querySelection()
            index = element.getIndexInParent()
            guard()
            with native_api_timing(kind):
                return selection.selectChild(index)
        raise RuntimeError('unsupported semantic action')

    def safe_canvas(self, w, snapshot):
        return (w['target']['appId'] == FIXTURE and w['element'].name == 'Brian Safe Canvas'
                and self.bounds(w['element']) == self.x.bounds(w['xid'])
                and snapshot['observation']['completeness'] == 'complete'
                and all(not n['sensitive'] and not n['actions'] for n in snapshot['observation']['nodes'])
                and self.unchanged(w, snapshot['refs']))

    def capture(self, w):
        return self.x.pixels(w['xid'])
