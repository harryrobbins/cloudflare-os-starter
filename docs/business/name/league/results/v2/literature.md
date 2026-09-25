# Literature: improving LLM peer-judging leagues (2026-09-24)

Read in full: PRD (pp. 3-6) and Walsh PeerRank (pp. 1-3). PiCO, Auto-Arena and LMC via their HTML full text. Everything else at abstract or snippet level; several 2026 arXiv items are unreplicated preprints.

## 1. Reputation/PageRank-weighted judges
- PeerRank (Walsh 2014): eigenvector of the grade matrix; halves error versus averaging on synthetic data; "favours consensus", non-monotonic. https://arxiv.org/pdf/1405.7192
- PRD (Li et al., TMLR 2024): reviewer weight = own win rate as a contestant, iterated; assumes better contestants judge better. https://arxiv.org/abs/2307.02762
- PiCO (ICLR 2025): learned weights raise Spearman correlation from about 0.74-0.80 to 0.84-0.89; the ability-consistency assumption is not tested. https://arxiv.org/html/2402.01830v3
- Auto-Arena: committee = top-5 by Elo, excluding the contestants' own families; discussion raises agreement from 0.41 to 0.54. https://arxiv.org/html/2405.20267v4
- Language Model Council: equal weights; 12 of 20 judges self-biased, but excluding self-graded battles barely changes the ranking; gains plateau at about 9 judges and about 50 items. https://arxiv.org/html/2406.08598v3
- Answering ability is not judging ability: judge generosity correlates r = -0.755 with the judge's own peer score. https://arxiv.org/pdf/2602.02589
- BT-σ: a per-judge discrimination parameter beats averaging. https://arxiv.org/abs/2602.16610
- EigenTrust: damping plus pre-trusted seeds against collusion. https://nlp.stanford.edu/pubs/eigentrust.pdf

## 2. Personas
- ChatEval: diverse roles 60.0% vs 53.8% for identical roles. https://arxiv.org/abs/2308.07201
- Expert personas do not improve factual accuracy. https://arxiv.org/abs/2512.05858
- Personas explain under 10% of annotation variance. https://arxiv.org/abs/2402.10811
- Persona conditioning mostly shifts strictness; rankings stay close to baseline. https://arxiv.org/abs/2608.10385

## 3. Temperature vs model vs prompt diversity
- Temperature 0 to 1: no significant accuracy effect. https://arxiv.org/abs/2402.05201
- 100 samples of one model give at most 1 signal dimension; 24 models give 4. https://arxiv.org/abs/2607.20464
- Prompt diversity (DIV-SE): +10 to +30 points. https://arxiv.org/abs/2310.07088
- Models agree on about 60% of errors. https://arxiv.org/abs/2506.07962

## 4. Ranking small fields
- Copeland/Borda counts are minimax-optimal for top-k. https://jmlr.org/papers/v18/16-206.html
- Swiss format is the most accurate for a fixed budget; knockout is the worst. https://arxiv.org/pdf/2103.06023
- Position bias can flip 66 of 80 verdicts; judge both orders. https://arxiv.org/abs/2305.17926
- Active top-k selection; bias correction needs 10 or more trusted anchors. https://arxiv.org/abs/2607.02104

## 5. Scoring rules and peer prediction
- Surprisingly popular. https://www.nature.com/articles/nature21054
- Generative peer prediction (GPPM). https://arxiv.org/abs/2405.15077
- BTS as a reward reduces sycophancy. https://arxiv.org/html/2608.25267v1
- Confidence weighting gives no gain at 25x the cost. https://arxiv.org/abs/2603.06612
