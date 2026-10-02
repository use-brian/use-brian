"""UTF-16 wire-boundary audit; assertions never render tested text or AX values."""
import copy
import io
import json
from pathlib import Path
import struct
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import contract as C
from atspi_backend import Backend, limited
from helper import Broker
from test_contract import Backend as MockBackend, Safety
from test_completeness import ReadingBackend

ASTRAL = chr(0x1f600)
COMBINING = 'e' + chr(0x301)


def target():
    return dict(appId='fixture',processId=1,processInstanceId='p',windowId='w',windowInstanceId='wi')


def grant():
    return dict(protocol=C.PROTOCOL,identity={k:k for k in C.IDENTITY},grantId='g',epoch=1,
        expiresAt=C.now()+60000,targets=[target()],allowControl=True,allowCapture=False,requester='local',goal='test')


def command():
    g = grant()
    return dict(protocol=C.PROTOCOL,identity=g['identity'],grantId='g',epoch=1,commandId='c',deadlineAt=C.now()+30000,
        action=dict(kind='setValue',target=target(),observationId='o',ref='r',text=''))


def request(identifier):
    body = json.dumps(dict(id=identifier,method='capabilities',payload={})).encode()
    return io.BytesIO(struct.pack('!I',len(body))+body)


class UnicodeWireTests(unittest.TestCase):
    def test_text_boundary_2048_and_2049_astral(self):
        for count, valid in ((2048,True),(2049,False)):
            value = ASTRAL*count
            self.assertEqual(C.utf16_units(value),count*2)
            self.assertIs(C.text(value,4096,0),valid)
            c = command()
            c['action']['text'] = value
            self.assertIs(C.command(c),valid)
    def test_combining_codepoints_not_normalized_or_counted_as_graphemes(self):
        value = COMBINING*2048
        self.assertEqual(C.utf16_units(value),4096)
        self.assertTrue(limited(value,4096)==value)
        self.assertTrue(C.text(value,4096,0))
        self.assertFalse(C.text(value+COMBINING,4096,0))
        # A scalar prefix can end before a combining mark. It must neither
        # normalize that prefix nor introduce a replacement/split surrogate.
        prefix = limited('x'*4095+COMBINING,4096)
        self.assertTrue(prefix=='x'*4095+'e')
    def test_non_bmp_never_split_at_odd_unit_boundary(self):
        self.assertTrue(limited('a'+ASTRAL,2)=='a')
        self.assertTrue(limited(ASTRAL,1)=='')
        self.assertTrue(limited('a'+ASTRAL,3)=='a'+ASTRAL)
        self.assertTrue(limited(ASTRAL+COMBINING,3)==ASTRAL+'e')
    def test_identity_all_fields_use_256_units(self):
        for field in C.IDENTITY:
            for count,valid in ((128,True),(129,False)):
                identity = {k:k for k in C.IDENTITY}
                identity[field] = ASTRAL*count
                self.assertIs(C.identity(identity),valid,field)
    def test_target_all_string_fields_use_256_units(self):
        for field in C.TARGET:
            if field=='processId':
                continue
            for count,valid in ((128,True),(129,False)):
                value = target()
                value[field] = ASTRAL*count
                self.assertIs(C.target(value),valid,field)
    def test_grant_strings_use_their_own_shared_limits(self):
        for field,limit in (('grantId',256),('requester',200),('goal',2000)):
            for count,valid in ((limit//2,True),(limit//2+1,False)):
                g = grant()
                g[field] = ASTRAL*count
                self.assertIs(C.grant(g),valid,field)
    def test_command_ids_and_refs_use_256_units(self):
        for field in ('grantId','commandId','observationId','ref','frameId'):
            for count,valid in ((128,True),(129,False)):
                c = command()
                if field in ('grantId','commandId'):
                    c[field] = ASTRAL*count
                elif field=='frameId':
                    c['action'] = dict(kind='click',target=target(),observationId='o',frameId=ASTRAL*count,x=1,y=1)
                else:
                    c['action'][field] = ASTRAL*count
                self.assertIs(C.command(c),valid,field)
    def test_pipe_request_and_response_ids_bounded_without_echoing_invalid(self):
        valid,invalid = ASTRAL*128,ASTRAL*129
        self.assertTrue(C.read_request(request(valid))['id']==valid)
        with self.assertRaises(ValueError):
            C.read_request(request(invalid))
        with self.assertRaises(ValueError):
            C.write_response(io.BytesIO(),invalid,True)
        self.assertTrue(C.receipt(dict(commandId=invalid),'denied')['commandId']=='invalid')
    def test_lease_id_uses_256_units(self):
        for count,valid in ((128,True),(129,False)):
            backend = MockBackend()
            b = Broker(backend,Safety())
            g = grant()
            g['targets'] = [backend.target]
            self.assertIs(b.start(dict(grant=g,leaseId=ASTRAL*count)),valid)
    def test_lone_surrogates_are_refused_without_validator_exception(self):
        for value in (chr(0xd800),chr(0xdc00),'prefix'+chr(0xd800)):
            self.assertFalse(C.text(value))
            c = command()
            c['action']['text'] = value
            self.assertFalse(C.command(c))
    def test_exported_names_values_roles_use_utf16(self):
        backend = ReadingBackend()
        for value in (ASTRAL*2048,ASTRAL*2049,COMBINING*2048,COMBINING*2049,'a'+ASTRAL*2048):
            backend.field.name = value
            backend.field.text = value
            n,complete = backend.node(backend.field,'ref',None,backend.target['appId'])
            expected_complete = C.utf16_units(value)<=4096
            self.assertIs(complete,expected_complete)
            for field in ('name','value'):
                self.assertLessEqual(C.utf16_units(n[field]),4096)
                self.assertTrue(value.startswith(n[field]))
                self.assertFalse(any(0xd800<=ord(char)<=0xdfff for char in n[field]))
            self.assertEqual(backend.tree(backend.w)[2], 'complete' if expected_complete else 'partial')
        for count in (50,51):
            backend.field.role = ASTRAL*count
            n,complete = backend.node(backend.field,'ref',None,backend.target['appId'])
            self.assertLessEqual(C.utf16_units(n['role']),100)
            self.assertTrue(n['role']==ASTRAL*50)
            self.assertFalse(any(0xd800<=ord(char)<=0xdfff for char in n['role']))
            if count==51:
                self.assertFalse(complete)
            self.assertTrue(n['sensitive'])
            self.assertTrue(n['name']=='')
            self.assertNotIn('value',n)
    def test_helper_independently_denies_oversize_without_approval_or_dispatch(self):
        backend = MockBackend()
        broker = Broker(backend,Safety())
        g = grant()
        g['targets'] = [backend.target]
        self.assertTrue(broker.start(dict(grant=g,leaseId='lease')))
        c = command()
        c['action'] = dict(kind='observe',target=backend.target)
        o = broker.execute(dict(command=c,leaseId='lease'))['observation']
        for count,valid in ((2049,False),(2048,True)):
            c = command()
            c['commandId'] = C.uid()
            c['action'].update(target=backend.target,observationId=o['id'],text=ASTRAL*count)
            p = dict(command=c,leaseId='lease')
            self.assertIs(broker.begin_approval(p),valid)
            if valid:
                self.assertTrue(broker.end_approval(dict(**p,approved=True)))
                self.assertEqual(broker.execute(p)['outcome'],'executed')
                self.assertTrue(backend.value==ASTRAL*count)
            else:
                self.assertEqual(broker.execute(p)['code'],'denied')
                self.assertEqual(backend.effects,0)
        self.assertEqual(backend.effects,1)
    def test_full_state_suffix_and_combining_mutation_remain_guarded(self):
        backend = ReadingBackend()
        for prefix in (ASTRAL*2048,COMBINING*2048):
            backend.field.text = prefix
            _,refs,complete = backend.tree(backend.w)
            self.assertEqual(complete,'complete')
            backend.field.text = prefix+'suffix'
            self.assertFalse(backend.unchanged(backend.w,refs))
            self.assertEqual(backend.tree(backend.w)[2],'partial')
    def test_fixed_capability_strings_and_generated_ids_fit_shared_bounds(self):
        caps = Broker(MockBackend(),Safety()).capabilities()
        self.assertLessEqual(len(caps['limitations']),20)
        self.assertTrue(all(C.text(v,C.LIMITATION_UNITS,0) for v in caps['limitations']))
        self.assertTrue(C.text(C.uid()))
    def test_frame_string_limit_independent_of_message_byte_budget(self):
        backend = MockBackend()
        backend.safe_canvas = lambda w,s: True
        backend.capture = lambda w: b'x'*(C.FRAME_DATA_UNITS//4*3+1)
        broker = Broker(backend,Safety())
        g = grant()
        g['targets'],g['allowCapture'] = [backend.target],True
        self.assertTrue(broker.start(dict(grant=g,leaseId='lease')))
        c = command()
        c['action'] = dict(kind='observe',target=backend.target)
        o = broker.execute(dict(command=c,leaseId='lease'))['observation']
        c['commandId'] = C.uid()
        c['action'] = dict(kind='capture',target=backend.target,observationId=o['id'])
        r = broker.execute(dict(command=c,leaseId='lease'))
        self.assertEqual(r['code'],'unsupported')
        self.assertNotIn('observation',r)


if __name__=='__main__':
    unittest.main()
