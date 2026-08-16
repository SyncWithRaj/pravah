import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom Metrics
const routingLatency = new Trend('geo_routing_duration_ms', true);
const routingSuccessRate = new Rate('geo_routing_success_rate');
const routingTotal = new Counter('geo_routing_requests_total');

export const options = {
  scenarios: {
    geo_routing_stress: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '5s', target: 50 },   // Warm up
        { duration: '10s', target: 150 }, // Ramp to 150 VUs
        { duration: '10s', target: 200 }, // Peak 200 VUs
        { duration: '5s', target: 0 },    // Cool down
      ],
      gracefulRampDown: '2s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],             // < 1% error rate
    geo_routing_duration_ms: ['p(95)<20', 'p(99)<40'], // sub-20ms p95, sub-40ms p99
    geo_routing_success_rate: ['rate>0.99'],    // > 99% success
  },
};

const CORE_URL = __ENV.CORE_URL || 'http://localhost:3000';
const FILE_ID = __ENV.FILE_ID || 'k6-benchmark-test-file';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

const REGIONS = ['ap-south-1', 'us-east-1', 'eu-central-1', 'ap-southeast-1', 'sa-east-1'];

export default function () {
  const randomRegion = REGIONS[Math.floor(Math.random() * REGIONS.length)];
  const url = `${CORE_URL}/api/v1/download/${FILE_ID}?region=${randomRegion}`;

  const params = {
    headers: {
      'Authorization': `Bearer ${AUTH_TOKEN}`,
      'Accept': 'application/json',
    },
    redirects: 0, // Do NOT follow redirect so we measure pure routing decision latency
  };

  const res = http.get(url, params);

  routingTotal.add(1);
  routingLatency.add(res.timings.duration);

  const passed = check(res, {
    'status is 302 or 200': (r) => r.status === 302 || r.status === 200,
    'has Location header': (r) =>
      r.headers['Location'] !== undefined ||
      r.headers['location'] !== undefined ||
      r.headers['x-cdn-edge'] !== undefined ||
      r.headers['X-CDN-Edge'] !== undefined,
  });

  routingSuccessRate.add(passed);

  sleep(0.05);
}
