"""Pure policy checks for the NOT enabled native XTest candidate."""
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from xinput import exact_event, frame_point
from helper import Broker
from test_contract import Backend, Safety


class XInputPolicyTests(unittest.TestCase):
    def setUp(self):
        self.event = dict(serial=42, type=15, source=4, master=2, detail=1, send_event=False)
        self.bounds = dict(x=-400, y=12, width=300, height=200)
    def matches(self, events):
        return exact_event(events, 4, 2, 15, 1, 42)
    def test_only_exact_sequence(self):
        self.assertTrue(self.matches([self.event]))
        self.assertFalse(self.matches([]))
        self.assertFalse(self.matches([self.event, self.event]))
    def test_physical_or_external_source_never_exempted(self):
        for field, value in [('source',6), ('master',7), ('serial',43), ('type',16), ('detail',2), ('send_event',True)]:
            event = dict(self.event, **{field:value})
            self.assertFalse(self.matches([event]), field)
    def test_interleaved_physical_revokes(self):
        other = dict(self.event, source=6)
        self.assertFalse(self.matches([other, self.event]))
        self.assertFalse(self.matches([self.event, other]))
    def test_transform_bounded_and_negative_origin(self):
        self.assertEqual(frame_point(self.bounds,300,200,1.9,2.9),(-399,14))
        for x,y in [(300,0),(0,200),(-1,0),(float('nan'),1),(1,float('inf')),(True,1)]:
            with self.assertRaises(ValueError):
                frame_point(self.bounds,300,200,x,y)
        with self.assertRaises(ValueError):
            frame_point(self.bounds,600,400,1,1)
    def test_input_not_advertised_even_with_ready_backend(self):
        self.assertFalse(Broker(Backend(), Safety()).capabilities()['input'])

class BrokerScrollTests(unittest.TestCase):
    def setUp(self):
        from test_contract import ContractTests
        self.fixture = ContractTests()
        self.fixture.setUp()
        self.b = self.fixture.b
        original_tree = self.fixture.os.tree
        def tree(w):
            nodes, refs, complete = original_tree(w)
            nodes[0]['actions'] = ['scroll']
            nodes[0]['role'] = 'scroll bar'
            return nodes, refs, complete
        self.fixture.os.tree = tree
        def act(kind, ref, action, guard):
            guard()
            self.assertEqual(kind, 'scroll')
            self.fixture.os.effects += 1
            self.fixture.os.value = str(action['deltaY'])
            return True
        self.fixture.os.act = act
        o = self.fixture.execute(self.fixture.cmd())['observation']
        self.c = self.fixture.cmd('scroll', observationId=o['id'], ref='r', deltaY=120)
    def test_scroll_exact_approval_and_no_replay(self):
        self.fixture.approve(self.c)
        self.assertEqual(self.fixture.execute(self.c)['outcome'],'executed')
        self.fixture.execute(self.c)
        self.assertEqual(self.fixture.os.effects,1)
    def test_scroll_without_approval_never_dispatches(self):
        self.assertEqual(self.fixture.execute(self.c)['code'],'approval_required')
        self.assertEqual(self.fixture.os.effects,0)
    def test_click_remains_unsupported_and_cannot_be_approved(self):
        c = self.fixture.cmd('click', observationId=self.c['action']['observationId'], frameId='frame', x=1,y=1)
        self.assertFalse(self.b.begin_approval(dict(command=c,leaseId='lease')))
        self.assertEqual(self.fixture.execute(c)['code'],'unsupported')
        self.assertEqual(self.fixture.os.effects,0)


if __name__ == '__main__':
    unittest.main()
