import unittest
from compare import compare, match
class ComparisonTest(unittest.TestCase):
 def test_same_camera_split_is_not_a_cut(self):
  a=[dict(timestamp=0,duration=4,channelId='a')]
  b=[dict(timestamp=0,duration=2,channelId='a'),dict(timestamp=2,duration=2,channelId='a')]
  r=compare(a,b,25);self.assertEqual(r['candidateTransitions'],0);self.assertEqual(r['cameraAgreement'],1)
 def test_frame_accuracy_does_not_hide_wrong_boundary(self):
  a=[dict(timestamp=0,duration=2,channelId='a'),dict(timestamp=2,duration=2,channelId='b')]
  b=[dict(timestamp=0,duration=2.08,channelId='a'),dict(timestamp=2.08,duration=1.92,channelId='b')]
  r=compare(a,b,25);self.assertEqual(r['cameraAgreement'],.98);self.assertEqual(r['withinOneFrame']['matches'],0);self.assertEqual(r['within250ms']['matches'],1)
 def test_rejects_missing_coverage(self):
  with self.assertRaises(ValueError):compare([dict(timestamp=1,duration=2,channelId='a')],[],25)
 def test_matching_does_not_lose_valid_boundary_pairs(self):
  r=match([(10,'a'),(13,'a')],[(8,'a'),(11,'a')],2)
  self.assertEqual(r['matches'],2)
 def test_high_frame_agreement_alone_cannot_pass(self):
  a=[dict(timestamp=0,duration=50,channelId='a'),dict(timestamp=50,duration=50,channelId='b')]
  b=[dict(timestamp=0,duration=50.08,channelId='a'),dict(timestamp=50.08,duration=49.92,channelId='b')]
  r=compare(a,b,25);self.assertGreater(r['cameraAgreement'],.99);self.assertFalse(r['targetMet'])
 def test_one_frame_gate_is_distinct_from_identical(self):
  a=[dict(timestamp=0,duration=50,channelId='a'),dict(timestamp=50,duration=50,channelId='b')]
  b=[dict(timestamp=0,duration=50.04,channelId='a'),dict(timestamp=50.04,duration=49.96,channelId='b')]
  self.assertFalse(compare(a,b,25)['targetMet'])
  r=compare(a,b,25,boundary_tolerance_frames=1);self.assertTrue(r['targetMet']);self.assertFalse(r['identical'])
if __name__=='__main__':unittest.main()

