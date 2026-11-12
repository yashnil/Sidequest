import { describe, expect, it } from 'vitest';
import { IMAGE_LICENCE_IDS, imageCropPolicy } from './imagery';

describe('licence-aware cropping', () => {
  it('crops public-domain and attribution-only files freely', () => {
    for (const id of ['CC0-1.0', 'public-domain', 'CC-PDM-1.0', 'CC-BY-2.0', 'CC-BY-4.0']) expect(imageCropPolicy(id).crop).toBe('free');
  });

  it('crops a share-alike file only with a notice that says so and offers the crop under the same licence', () => {
    for (const version of ['2.0', '3.0', '4.0']) {
      const policy = imageCropPolicy(`CC-BY-SA-${version}`);
      expect(policy.crop).toBe('with_notice');
      expect(policy.notice?.text).toBe(`Cropped; this crop is shared under CC BY-SA ${version}`);
      expect(policy.notice?.licenceUrl).toBe(`https://creativecommons.org/licenses/by-sa/${version}/`);
    }
  });

  it('never crops a licence it does not know', () => {
    expect(imageCropPolicy('CC-BY-NC-4.0').crop).toBe('never');
    expect(imageCropPolicy(null).crop).toBe('never');
    /* Every allowed licence has a defined policy. */
    for (const id of IMAGE_LICENCE_IDS) expect(imageCropPolicy(id).crop).not.toBe('never');
  });
});
