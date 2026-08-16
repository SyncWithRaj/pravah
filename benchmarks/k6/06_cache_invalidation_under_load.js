import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom Metrics
const readLatency = new Trend('invalidation_read_duration_ms', true);
const readSuccessRate = new Rate('invalidation_read_success_rate');
const readTotal = new Counter('invalidation_read_requests_total');

export const options = {
  scenarios: {
    continuous_reads: {
      executor: 'constant-vus',
      vus: 30,
      duration: '15s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],                  // < 2% error rate during invalidation
    invalidation_read_duration_ms: ['p(95)<150'],    // sub-150ms p95
    invalidation_read_success_rate: ['rate>0.98'],  // > 98% success
  },
};

const EDGE_URL = __ENV.EDGE_URL || 'http://localhost:3001';
const FILE_ID = __ENV.FILE_ID || 'k6-benchmark-test-file';

export default function () {
  const url = `${EDGE_URL}/edge/content/${FILE_ID}?v=1`;
  const params = {
    headers: {
      'Accept-Encoding': 'gzip, br',
    },
  };

  const res = http.get(url, params);

  readTotal.add(1);
  readLatency.add(res.timings.duration);

  const passed = check(res, {
    'status is 200 or 304': (r) => r.status === 200 || r.status === 304,
  });

  readSuccessRate.add(passed);
  sleep(0.05);
}
