import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom Metrics
const cacheMissLatency = new Trend('edge_cache_miss_duration_ms', true);
const cacheMissSuccessRate = new Rate('edge_cache_miss_success_rate');
const missTotal = new Counter('edge_cache_miss_requests_total');

export const options = {
  scenarios: {
    cache_miss_stream: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '5s', target: 25 },  // Warm up
        { duration: '10s', target: 50 }, // Ramp to 50 concurrent misses
        { duration: '5s', target: 0 },   // Cool down
      ],
      gracefulRampDown: '2s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],               // < 5% error rate
    edge_cache_miss_duration_ms: ['p(95)<150'],    // sub-150ms p95 for origin proxy stream
    edge_cache_miss_success_rate: ['rate>0.95'],  // > 95% success
  },
};

const EDGE_URL = __ENV.EDGE_URL || 'http://localhost:3001';
const FILE_ID = __ENV.FILE_ID || 'k6-benchmark-test-file';

export default function () {
  const url = `${EDGE_URL}/edge/content/${FILE_ID}?v=1`;
  const params = {
    headers: {
      'Accept-Encoding': 'gzip, br',
      'X-Forwarded-For': '157.240.199.35',
    },
  };


  const res = http.get(url, params);

  missTotal.add(1);
  cacheMissLatency.add(res.timings.duration);

  const passed = check(res, {
    'status is 200': (r) => r.status === 200,
  });

  cacheMissSuccessRate.add(passed);
  sleep(0.1);
}
