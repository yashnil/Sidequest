# Destination recommender rebuild: literature review

Scope: this review informs and critiques the design we have already chosen. That design is a curated catalogue of about 220 destinations, a deterministic adaptive interview, multi-criteria scoring with explicit unknowns, an MMR shortlist, no popularity boost, and critique-based refinement. It does not propose a new design. Every citation below was checked against Crossref or the publisher's record (October 2026). Labels: **proven / widely used** means replicated or standard practice; **experimental** means a small number of studies or offline-only evidence.

## 1. Destination choice-set formation

Tourism research models destination choice as a funnel. An awareness set narrows to an evoked or consideration set, which narrows to a small late set, and a final choice is made from that late set (Crompton 1992; Woodside & Lysonski 1989). Destinations are dropped along the way as "inept" (rejected), "inert" (no feeling either way) or "unavailable". Um & Crompton (1990) show that beliefs and attitudes about a destination's attributes decide whether it survives each stage. **Proven / widely used** as a descriptive model, mostly from survey studies. Woodside & Lysonski's model itself rests on exploratory evidence.

*Implication: agree.* A shortlist of 3–5 mirrors the late consideration set. Travellers do not rank 220 options; they reject most of them on a few attributes. This supports applying hard constraints early (season, access, cost ceiling) and showing a small, explained set. It also argues that a "not for me" action (the inept set) is worth as much as a positive one.

## 2. Tourism recommender surveys

Borràs, Moreno & Valls (2014) survey intelligent tourism recommenders and find knowledge-based and hybrid approaches dominant, because rating data is sparse and trips are infrequent. Lim et al. (2019) survey tour and itinerary recommendation; that field mostly mines geotagged photos and check-ins to infer interest and popularity. **Widely used.**

*Implication: agree, with a risk flagged.* With no interaction history, an editorial knowledge base is the standard answer. Much of the trip-recommendation literature, however, uses popularity as a proxy for quality. We should not import that proxy (see §6).

## 3. Active preference elicitation and question selection

Chajewska, Koller & Parr (2000) keep a distribution over a user's utility function. At each step they ask the question with the highest value of information, and they stop when the expected loss falls below a threshold. Viappiani & Boutilier (2010) show that, under fairly general conditions, the best choice query by expected value of information (EVOI) is the same as the best recommendation set. In collaborative filtering, Rashid et al. (2002) and the Elahi, Ricci & Rubens (2016) survey find that the question-selection strategy changes both user effort and accuracy. Pure entropy-based selection can pick questions users cannot answer. Christakopoulou, Radlinski & Hofmann (2016) pick questions adaptively for cold-start restaurant recommendation and learn faster than with fixed question orders. **Theory proven; adaptive interviews in live products are experimental**, with mostly offline or small online evidence.

*Implication: agree, with two risks.*
- Our stopping rule (expected change in the top-k shortlist is small) is a cheap, decision-focused form of EVOI and is better than plain information gain over all 220 items. A question that reorders positions 40–60 is worth nothing to the traveller.
- **Risk 1:** expected change is only as good as the answer model. With no data, we must assume answer probabilities, for example uniform or editorial priors. These assumptions should be explicit and covered by tests.
- **Risk 2:** Rashid et al. warn that the most informative question can be the hardest to answer. Our question bank should hold only questions a traveller can answer without knowing the catalogue, and "skip" must count as an outcome with zero information, not as a neutral answer.

## 4. Conversational and critiquing recommenders

Chen & Pu (2012) survey critiquing-based recommenders. A critique can be user-initiated ("cheaper"), system-suggested, or written in natural language. Their user studies find that hybrid critiquing gives more confident decisions. McCarthy et al. (2005) generate *compound* critiques dynamically, such as "warmer **and** less remote", from the remaining items, and report shorter sessions. Jannach et al. (2021) survey conversational recommenders more broadly. **Proven / widely used** for structured catalogues with a few attributes, which matches our case.

*Implication: agree.* "Warmer", "less expensive" and "more like #2" are standard unit and similarity critiques. Two points from this literature:
- A critique should move along the attribute and keep the rest of the profile fixed. "Cheaper" must not silently drop the traveller's experience fit.
- Dynamic compound critiques built from the attributes on which the remaining candidates actually differ give a principled way to offer suggestion chips.
- *Risk:* on 0–3 integer scales, "warmer than #1" often has no strictly better candidate. The UI needs an honest "nothing warmer fits your other constraints" state.

## 5. Diversity: MMR, submodularity, calibration

MMR re-ranks items greedily by λ·relevance − (1−λ)·max similarity to items already chosen (Carbonell & Goldstein 1998). Ziegler et al. (2005) show that topic diversification lowers offline accuracy but raises user satisfaction. Agrawal et al. (2009) treat diversification as covering a user's possible intents. Coverage objectives of this kind are submodular, so greedy selection carries the (1−1/e) guarantee of Nemhauser, Wolsey & Fisher (1978). MMR itself is a heuristic with no such guarantee. Steck (2018) proposes *calibration*: the mix of a list should match the mix of the user's interests, rather than simply maximising dissimilarity. **MMR and greedy diversification: proven / widely used. Calibration: widely cited, mostly offline evidence.**

*Implication: agree, with refinements.*
- Making λ depend on how broad the request is matches the intent-coverage view. A broad request ("somewhere warm in March") is ambiguous, so diversity hedges. A region-restricted request is not ambiguous, so diversity should give way to relevance.
- **Risk:** cosine similarity over experience profiles plus geographic proximity can still return three near-identical "beach" trips in three continents. Calibration suggests checking that the shortlist's experience mix reflects the stated interests in proportion, not just that the items are dissimilar to each other.
- **Risk:** set a relevance floor so MMR never brings in a poor-fit item just because it is different.

## 6. Popularity bias

Abdollahpouri, Burke & Mobasher (2017) show that recommenders over-concentrate on popular items and that a regulariser can trade accuracy for long-tail coverage. Abdollahpouri et al. (2019) show that users with niche tastes are the most poorly served by popularity bias. **Proven / widely used** as a phenomenon; the remedies are experimental.

*Implication: agree.* Never boosting on popularity and letting "familiarity" matter only against a stated appetite is a direct, defensible answer. **Residual risk:** popularity can come back through the catalogue itself. Editors know famous places better, so those places get fuller, more confident scores, while lesser-known places get more unknowns. Because unknowns are excluded rather than scored in the middle, sparse records can lose by default. Track how complete the scores are, split by familiarity tier.

## 7. Multi-criteria decision making and missing criteria

Multi-attribute utility theory (MAUT; Keeney & Raiffa 1976) supports a weighted additive score when the criteria are preferentially independent. It is compensatory: a strength on one criterion offsets a weakness on another. Outranking methods (ELECTRE; Roy 1991) are non-compensatory and use veto thresholds. Multi-criteria recommenders (Adomavicius & Kwon 2007) show that modelling criteria separately beats a single overall rating. **Proven / widely used.** We found no strong, verifiable standard for missing criterion values; the common practices are imputation, re-normalising the weights over known criteria, or interval or confidence scoring.

*Implication: mostly agree, with one real risk.*
- Separating hard constraints from soft preferences is the outranking veto idea in practice, and it avoids the classic MAUT failure where a great beach offsets "I can't go in that season".
- **Risk:** leaving unknowns out of the score and re-normalising over the known criteria lets a sparse destination win on two strong known scores. Report the coverage ("scored on 4 of 7 things you care about") next to the score, and break ties toward fuller coverage. Do not drop the item, because unknown is not the same as false.
- 0–3 editorial scales are ordinal. A weighted sum treats them as interval data, which is acceptable if the result is shown as an ordering and not as a precise number.

## 8. Knowledge-based and constraint-based recommenders under cold start

Burke (2002) classifies hybrids and places knowledge-based recommendation as the cold-start answer: it needs no ratings, only item knowledge and a model of user needs. Felfernig & Burke (2008) describe constraint-based recommenders, including what to do when no item satisfies every constraint (identify and relax the conflicting constraints). **Proven / widely used** in high-stakes, rarely purchased domains such as finance and travel.

*Implication: agree.* A curated catalogue with provenance is the right architecture. **Risk:** an over-constrained request ("warm, cheap, remote, in January, in Europe") will return nothing. The constraint-based literature says to explain the conflict and offer the smallest relaxation, not to quietly turn hard constraints into soft ones.

## 9. Tourist Trip Design Problem (TTDP) and orienteering

The TTDP is modelled as orienteering: maximise the score of the visited points of interest within a time budget, often with time windows (Vansteenwegen, Souffriau & Van Oudheusden 2011; Gavalas et al. 2014). It is NP-hard and solved with heuristics. **Proven / widely used.**

*Implication: out of scope here, but there is a coupling risk.* Destination choice comes before itinerary building, but a destination is only a good pick if a feasible trip exists for the traveller's days and transport. The catalogue's "access" and "challenge" scores stand in for that. Check that the downstream planner can actually fill the trip length for shortlisted destinations, so the recommender does not promise a trip the planner cannot build.

## 10. Geographic entity disambiguation

Gritta et al. (2018) find that geoparsers still struggle with ambiguous names and metonymy, and that results on lab data rarely carry over. **Proven** as a difficulty.

*Implication: agree.* This is the failure that produced the old recommender, which ranked administrative divisions as though they were destinations. Each catalogue entry should carry a typed identity (region, park, city, island) checked through the existing semantic gate. Region words in free text ("Patagonia", "the Alps") should map to catalogue entries or region filters, never to a geocoder's first result.

## 11. Personalised appetite for distance, diversity and popularity

Lee et al. (2022) learn each user's own weighting of travel distance, diversity and popularity in tour recommendation, and report gains over a single shared weighting. **Experimental** (one study, offline, TripAdvisor and Naver data).

*Implication: agree.* This directly supports treating familiarity, diversity and remoteness as *stated appetites* with per-traveller direction, rather than global constants.

## What we adopt, what we don't, and why

**Adopt:**
- Funnel-shaped shortlisting that rejects early (§1).
- Knowledge-based scoring over a curated catalogue (§2, §8).
- Hard constraints as vetoes with an explained relaxation path (§7, §8).
- Question selection by decision-relevant expected change with a stopping threshold (§3).
- Unit and compound critiques built from the remaining candidates (§4).
- MMR with breadth-dependent λ and a relevance floor (§5).
- No popularity boost, with familiarity as a stated appetite (§6, §11).

**Adopt with guards:**
- Excluding unknowns, guarded by visible coverage and tie-breaks toward fuller coverage (§6, §7).
- An explicit, tested answer-probability model for the interview (§3).
- A calibration check on the shortlist's experience mix (§5).

**Do not adopt:**
- Learned or collaborative models: we have no interaction data, and every survey says cold start defeats them.
- Full Bayesian or POMDP elicitation (Chajewska; Viappiani & Boutilier): it is principled, but it needs utility priors we cannot justify, and our myopic, deterministic version is testable.
- Outranking methods as the scorer: vetoes give us their main benefit, and their pairwise reports are hard to explain to a traveller.
- Popularity as a quality proxy, which is common in the trip-recommendation literature: it re-creates the bias we are trying to remove.

## References

- Abdollahpouri, H., Burke, R., Mobasher, B. (2017). Controlling popularity bias in learning-to-rank recommendation. *RecSys '17*, 42–46. https://doi.org/10.1145/3109859.3109912
- Abdollahpouri, H., Mansoury, M., Burke, R., Mobasher, B. (2019). The unfairness of popularity bias in recommendation. arXiv:1907.13286. https://arxiv.org/abs/1907.13286
- Adomavicius, G., Kwon, Y. (2007). New recommendation techniques for multicriteria rating systems. *IEEE Intelligent Systems* 22(3), 48–55. https://doi.org/10.1109/MIS.2007.58
- Agrawal, R., Gollapudi, S., Halverson, A., Ieong, S. (2009). Diversifying search results. *WSDM '09*, 5–14. https://doi.org/10.1145/1498759.1498766
- Borràs, J., Moreno, A., Valls, A. (2014). Intelligent tourism recommender systems: A survey. *Expert Systems with Applications* 41(16), 7370–7389. https://doi.org/10.1016/j.eswa.2014.06.007
- Burke, R. (2002). Hybrid recommender systems: Survey and experiments. *User Modeling and User-Adapted Interaction* 12(4), 331–370. https://doi.org/10.1023/A:1021240730564
- Carbonell, J., Goldstein, J. (1998). The use of MMR, diversity-based reranking for reordering documents and producing summaries. *SIGIR '98*, 335–336. https://doi.org/10.1145/290941.291025
- Chajewska, U., Koller, D., Parr, R. (2000). Making rational decisions using adaptive utility elicitation. *AAAI-00*, 363–369. https://mlanthology.org/aaai/2000/chajewska2000aaai-making
- Chen, L., Pu, P. (2012). Critiquing-based recommenders: survey and emerging trends. *User Modeling and User-Adapted Interaction* 22(1–2), 125–150. https://doi.org/10.1007/s11257-011-9108-6
- Christakopoulou, K., Radlinski, F., Hofmann, K. (2016). Towards conversational recommender systems. *KDD '16*, 815–824. https://doi.org/10.1145/2939672.2939746
- Crompton, J. (1992). Structure of vacation destination choice sets. *Annals of Tourism Research* 19(3), 420–434. https://doi.org/10.1016/0160-7383(92)90128-C
- Elahi, M., Ricci, F., Rubens, N. (2016). A survey of active learning in collaborative filtering recommender systems. *Computer Science Review* 20, 29–50. https://doi.org/10.1016/j.cosrev.2016.05.002
- Felfernig, A., Burke, R. (2008). Constraint-based recommender systems: technologies and research issues. *ICEC '08*, 1–10. https://doi.org/10.1145/1409540.1409544
- Gavalas, D., Konstantopoulos, C., Mastakas, K., Pantziou, G. (2014). A survey on algorithmic approaches for solving tourist trip design problems. *Journal of Heuristics* 20(3), 291–328. https://doi.org/10.1007/s10732-014-9242-5
- Gritta, M., Pilehvar, M. T., Limsopatham, N., Collier, N. (2018). What's missing in geographical parsing? *Language Resources and Evaluation* 52(2), 603–623. https://doi.org/10.1007/s10579-017-9385-8
- Jannach, D., Manzoor, A., Cai, W., Chen, L. (2021). A survey on conversational recommender systems. *ACM Computing Surveys* 54(5), 1–36. https://doi.org/10.1145/3453154
- Keeney, R. L., Raiffa, H. (1976). *Decisions with Multiple Objectives: Preferences and Value Tradeoffs*. Wiley. (Book; reissued by Cambridge University Press, 1993.)
- Lee, J., Shin, J. A., Chae, D.-K., Lee, S.-C. (2022). Personalized tour recommendation via analyzing user tastes for travel distance, diversity and popularity. *Electronics* 11(7), 1120. https://doi.org/10.3390/electronics11071120
- Lim, K. H., Chan, J., Karunasekera, S., Leckie, C. (2019). Tour recommendation and trip planning using location-based social media: a survey. *Knowledge and Information Systems* 60, 1247–1275. https://doi.org/10.1007/s10115-018-1297-4
- McCarthy, K., Reilly, J., McGinty, L., Smyth, B. (2005). Experiments in dynamic critiquing. *IUI '05*, 175–182. https://doi.org/10.1145/1040830.1040871
- Nemhauser, G. L., Wolsey, L. A., Fisher, M. L. (1978). An analysis of approximations for maximizing submodular set functions—I. *Mathematical Programming* 14(1), 265–294. https://doi.org/10.1007/BF01588971
- Rashid, A. M., Albert, I., Cosley, D., Lam, S. K., McNee, S. M., Konstan, J. A., Riedl, J. (2002). Getting to know you: learning new user preferences in recommender systems. *IUI '02*, 127–134. https://doi.org/10.1145/502716.502737
- Roy, B. (1991). The outranking approach and the foundations of ELECTRE methods. *Theory and Decision* 31(1), 49–73. https://doi.org/10.1007/BF00134132
- Steck, H. (2018). Calibrated recommendations. *RecSys '18*, 154–162. https://doi.org/10.1145/3240323.3240372
- Um, S., Crompton, J. (1990). Attitude determinants in tourism destination choice. *Annals of Tourism Research* 17(3), 432–448. https://doi.org/10.1016/0160-7383(90)90008-F
- Vansteenwegen, P., Souffriau, W., Van Oudheusden, D. (2011). The orienteering problem: A survey. *European Journal of Operational Research* 209(1), 1–10. https://doi.org/10.1016/j.ejor.2010.03.045
- Viappiani, P., Boutilier, C. (2010). Optimal Bayesian recommendation sets and myopically optimal choice query sets. *NIPS 23*, 2352–2360. https://proceedings.neurips.cc/paper/2010/hash/550a141f12de6341fba65b0ad0433500-Abstract.html
- Woodside, A. G., Lysonski, S. (1989). A general model of traveler destination choice. *Journal of Travel Research* 27(4), 8–14. https://doi.org/10.1177/004728758902700402
- Ziegler, C.-N., McNee, S. M., Konstan, J. A., Lausen, G. (2005). Improving recommendation lists through topic diversification. *WWW '05*, 22–32. https://doi.org/10.1145/1060745.1060754
