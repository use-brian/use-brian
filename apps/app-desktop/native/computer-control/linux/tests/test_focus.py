"""Focus restoration policy using real backend algorithm and mock X11/AT-SPI."""
import copy
import unittest
from atspi_backend import Backend
from test_completeness import ReadingBackend


class X:
    foreground_window = 200
    blocked = False
    requests = 0
    after_request = lambda self: None
    def foreground(self):
        return self.foreground_window
    def pid(self, window):
        return 55 if window == 200 else 66
    def unoccluded(self, window, allowed_window=0):
        return not self.blocked
    def request_activation(self, window):
        assert window == 100  # never a replacement/parent/arbitrary window
        self.requests += 1
        self.foreground_window = window
        self.after_request()


class RestoringBackend(ReadingBackend):
    restore_consented_focus = Backend.restore_consented_focus
    def __init__(self):
        super().__init__()
        self.x = X()
        self.w['xid'] = 100
        self.valid = True
        self.geometry = dict(x=0,y=0,width=400,height=300)
    def live(self,target):
        if not self.valid:
            raise ValueError('stale identity')
        return super().live(target)
    def context(self,w):
        return dict(bounds=copy.deepcopy(self.geometry),displayLayoutVersion='layout',foreground=self.x.foreground()==100)


class FocusTests(unittest.TestCase):
    def setUp(self):
        self.os = RestoringBackend()
        self.context = self.os.context(self.os.w)
        _,self.refs,complete = self.os.tree(self.os.w)
        self.assertEqual(complete,'complete')
    def restore(self,guard=lambda: None):
        return self.os.restore_consented_focus(self.os.w,self.refs,self.context,55,guard)
    def test_exact_selected_window_only(self):
        self.assertTrue(self.restore())
        self.assertEqual(self.os.x.requests,1)
        self.assertEqual(self.os.x.foreground(),100)
        self.assertEqual(self.os.effects,0)
    def test_pre_request_content_mutation_denies_focus(self):
        self.os.field.text='changed'
        with self.assertRaises(ValueError):
            self.restore()
        self.assertEqual(self.os.x.requests,0)
    def test_post_request_tree_mutation_denies_effect(self):
        self.os.x.after_request=lambda: setattr(self.os.field,'text','changed')
        with self.assertRaises(ValueError):
            self.restore()
        self.assertEqual(self.os.x.requests,1)
        self.assertEqual(self.os.effects,0)
    def test_post_request_geometry_mutation_denies_effect(self):
        self.os.x.after_request=lambda: self.os.geometry.update(x=40)
        with self.assertRaises(ValueError):
            self.restore()
        self.assertEqual(self.os.effects,0)
    def test_post_request_identity_mutation_denies_effect(self):
        self.os.x.after_request=lambda: setattr(self.os,'valid',False)
        with self.assertRaises(ValueError):
            self.restore()
        self.assertEqual(self.os.effects,0)
    def test_post_request_overlay_denies_effect(self):
        self.os.x.after_request=lambda: setattr(self.os.x,'blocked',True)
        with self.assertRaises(ValueError):
            self.restore()
        self.assertEqual(self.os.effects,0)
    def test_revoked_before_request_never_activates(self):
        def revoked():
            raise ValueError('revoked')
        with self.assertRaises(ValueError):
            self.restore(revoked)
        self.assertEqual(self.os.x.requests,0)


if __name__ == '__main__':
    unittest.main()
