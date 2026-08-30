import {
  getApplicableProfiles,
  TranscodeQuality,
} from './transcoding.constants';

describe('Transcoding Constants & Profile Selector', () => {
  it('should return all 6 profiles for a 1080p source (1920x1080)', () => {
    const profiles = getApplicableProfiles(1920, 1080);
    expect(profiles.length).toBe(6);
    expect(profiles.map((p) => p.name)).toEqual([
      '1080p',
      '720p',
      '480p',
      '360p',
      '240p',
      '144p',
    ]);
  });

  it('should return 5 profiles for a 720p source (1280x720) - NO UPSCALING', () => {
    const profiles = getApplicableProfiles(1280, 720);
    expect(profiles.length).toBe(5);
    expect(profiles.map((p) => p.name)).toEqual([
      '720p',
      '480p',
      '360p',
      '240p',
      '144p',
    ]);
    expect(profiles.find((p) => p.name === '1080p')).toBeUndefined();
  });

  it('should return 4 profiles for a 480p source (854x480)', () => {
    const profiles = getApplicableProfiles(854, 480);
    expect(profiles.length).toBe(4);
    expect(profiles.map((p) => p.name)).toEqual([
      '480p',
      '360p',
      '240p',
      '144p',
    ]);
  });

  it('should return 3 profiles for a 360p source (640x360)', () => {
    const profiles = getApplicableProfiles(640, 360);
    expect(profiles.length).toBe(3);
    expect(profiles.map((p) => p.name)).toEqual(['360p', '240p', '144p']);
  });

  it('should return 2 profiles for a 240p source (426x240)', () => {
    const profiles = getApplicableProfiles(426, 240);
    expect(profiles.length).toBe(2);
    expect(profiles.map((p) => p.name)).toEqual(['240p', '144p']);
  });

  it('should return only 1 profile for a 144p source (256x144)', () => {
    const profiles = getApplicableProfiles(256, 144);
    expect(profiles.length).toBe(1);
    expect(profiles[0].name).toBe('144p');
    expect(profiles[0].prismaQuality).toBe(TranscodeQuality.Q_144P);
  });

  it('should return empty array for ultra-low resolution smaller than 144p', () => {
    const profiles = getApplicableProfiles(100, 100);
    expect(profiles).toEqual([]);
  });

  it('should correctly filter intermediate/custom resolutions (e.g. 1000x600)', () => {
    const profiles = getApplicableProfiles(1000, 600);
    // 1080p (1920x1080) and 720p (1280x720) exceed height 600
    // 480p (854x480), 360p (640x360), 240p (426x240), 144p (256x144) fit
    expect(profiles.map((p) => p.name)).toEqual([
      '480p',
      '360p',
      '240p',
      '144p',
    ]);
  });
});
