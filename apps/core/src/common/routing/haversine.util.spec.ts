import { haversineDistance } from './haversine.util';

describe('haversineDistance', () => {
  it('returns zero for identical coordinates', () => {
    expect(haversineDistance(19.076, 72.8777, 19.076, 72.8777)).toBe(0);
  });

  it('computes the Mumbai to Delhi distance within a sensible tolerance', () => {
    const distance = haversineDistance(19.076, 72.8777, 28.6139, 77.209);

    expect(distance).toBeGreaterThan(1100);
    expect(distance).toBeLessThan(1200);
  });

  it('is symmetric', () => {
    const forward = haversineDistance(51.5074, -0.1278, 40.7128, -74.006);
    const reverse = haversineDistance(40.7128, -74.006, 51.5074, -0.1278);

    expect(forward).toBeCloseTo(reverse, 6);
  });

  it('handles antipodal points', () => {
    expect(haversineDistance(0, 0, 0, 180)).toBeCloseTo(20015.09, 1);
  });
});
