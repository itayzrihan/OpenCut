"""Independent exhaustive oracle for the experimental duration-constrained decoder."""
import importlib.util
import itertools
import pathlib
import unittest

AVAILABLE=all(importlib.util.find_spec(n) for n in ['numpy','scipy','sklearn'])

@unittest.skipUnless(AVAILABLE,'Install the optional reference-learning dependencies')
class DecoderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import numpy as np
        cls.np=np
        spec=importlib.util.spec_from_file_location('reference_learning',pathlib.Path(__file__).with_name('learn-reference.py'))
        cls.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(cls.module)

    def test_matches_exhaustive_legal_plans(self):
        np=self.np;rng=np.random.default_rng(19)
        for _ in range(8):
            probability=rng.uniform(.05,.95,11);penalty=.8
            def score(labels):
                cuts=np.r_[0,np.flatnonzero(np.diff(labels))+1,len(labels)]
                lengths=np.diff(cuts)
                if min(lengths)<2 or max(lengths)>5:return -np.inf
                return sum(np.log(p if c else 1-p) for c,p in zip(labels,probability))-penalty*len(lengths)
            oracle=max(score(labels) for labels in itertools.product([0,1],repeat=11))
            actual=self.module.decode(probability,1,min_seconds=2,max_seconds=5,transition_penalty=penalty)
            self.assertAlmostEqual(score(actual),oracle,places=10)

    def test_maximum_duration_changes_camera_not_just_segment(self):
        np=self.np
        labels=self.module.decode(np.full(60,.999),1,min_seconds=2,max_seconds=20)
        cuts=self.module.cuts_from_labels(labels,['a','b'],1)
        self.assertTrue(all(2<=c['duration']<=20 for c in cuts))
        self.assertGreater(len(cuts),2)
        self.assertTrue(all(a['channelId']!=b['channelId'] for a,b in zip(cuts,cuts[1:])))

    def test_validation_never_counts_artificial_block_join_as_a_cut(self):
        np=self.np;labels=np.r_[np.zeros(50,dtype=int),np.ones(50,dtype=int)]
        _,metrics,blocks=self.module.evaluate_blocks(np.where(labels,.99,.01),labels,['a','b'],25,np.array([0,50,100]),20)
        self.assertEqual(len(blocks),2)
        self.assertEqual(metrics['cameraAgreement'],1)
        self.assertEqual(metrics['referenceTransitions'],0)
        self.assertEqual(metrics['candidateTransitions'],0)
        self.assertTrue(metrics['targetMet'])

if __name__=='__main__':unittest.main()
