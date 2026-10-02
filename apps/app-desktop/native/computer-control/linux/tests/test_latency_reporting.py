"""A fast partial observation is still a failed expected latency sample."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import benchmark_gedit as benchmark
from gedit_timing import DeadlineGuard, TimedBroker
from test_completeness import ReadingBackend


class ReportingTests(unittest.TestCase):
    def test_partial_observation_fails_even_with_zero_child_exit(self):
        sample=dict(operation='observe',phase='cold',ms=1801.0,success=False,
                    overBudget=False,expectedSuccess=True,completeness='partial')
        child=SimpleNamespace(returncode=0,communicate=lambda **kw:('GEDIt_TIMING '+json.dumps(sample)+'\n',None))
        output=io.StringIO()
        with patch.object(benchmark.subprocess,'Popen',return_value=child), patch.object(sys,'argv',['benchmark','--sessions','1']), redirect_stdout(output):
            self.assertEqual(benchmark.main(),1)
        self.assertIn('cold observe 1 0 1801.000 1801.000',output.getvalue())
        self.assertIn('FAILED_REQUEST',output.getvalue())
        self.assertIn('failedExpected=1',output.getvalue())
    def test_nonprofiled_watchdog_failure_is_not_hidden(self):
        sample=dict(operation='capture',phase='cold',ms=3501.0,success=False,
                    overBudget=True,expectedSuccess=False)
        child=SimpleNamespace(returncode=1,communicate=lambda **kw:('GEDIt_TIMING '+json.dumps(sample)+'\n',None))
        output=io.StringIO()
        with patch.object(benchmark.subprocess,'Popen',return_value=child), patch.object(sys,'argv',['benchmark','--sessions','1']), redirect_stdout(output):
            self.assertEqual(benchmark.main(),1)
        self.assertIn('FAILED_REQUEST',output.getvalue())
        self.assertIn('overBudget=1',output.getvalue())
    def test_expected_editor_capture_denial_is_not_positive_sample(self):
        broker=TimedBroker(ReadingBackend(),DeadlineGuard())
        output=io.StringIO()
        with redirect_stdout(output):
            broker.measured('capture',lambda b,p:dict(code='denied',outcome='not_executed'),{})
        sample=json.loads(output.getvalue().split(' ',1)[1])
        self.assertFalse(sample['expectedSuccess'])
        self.assertFalse(sample['overBudget'])


if __name__=='__main__':unittest.main()
