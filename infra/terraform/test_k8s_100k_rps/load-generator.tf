# ============================================================================
# Load Generator — EC2 instance with k6 for 100k RPS stress testing
# ============================================================================

data "aws_ami" "amazon_linux_2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_security_group" "load_generator" {
  name_prefix = "${var.cluster_name}-loadgen-"
  vpc_id      = aws_vpc.pravah.id

  # SSH access
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.cluster_name}-loadgen-sg"
  }
}

resource "aws_key_pair" "load_generator" {
  key_name   = "${var.cluster_name}-loadgen-key"
  public_key = tls_private_key.load_generator.public_key_openssh
}

resource "tls_private_key" "load_generator" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "local_file" "private_key" {
  content         = tls_private_key.load_generator.private_key_pem
  filename        = "${path.module}/loadgen-key.pem"
  file_permission = "0400"
}

resource "aws_instance" "load_generator" {
  ami                    = data.aws_ami.amazon_linux_2023.id
  instance_type          = var.load_generator_instance_type
  key_name               = aws_key_pair.load_generator.key_name
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.load_generator.id]

  associate_public_ip_address = true

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
  }

  user_data = <<-USERDATA
    #!/bin/bash
    set -e

    # Install k6 load testing tool
    dnf install -y https://dl.k6.io/rpm/repo.rpm || true
    dnf install -y k6 || {
      curl -sL https://github.com/grafana/k6/releases/download/v0.52.0/k6-v0.52.0-linux-amd64.tar.gz | tar xz
      mv k6-v0.52.0-linux-amd64/k6 /usr/local/bin/k6
    }

    # Install kubectl
    curl -Lo /usr/local/bin/kubectl "https://dl.k8s.io/release/v1.30.0/bin/linux/amd64/kubectl"
    chmod +x /usr/local/bin/kubectl

    # Install AWS CLI (pre-installed on AL2023)
    # Install eksctl
    curl -sLO "https://github.com/eksctl-io/eksctl/releases/latest/download/eksctl_Linux_amd64.tar.gz"
    tar xz -C /usr/local/bin -f eksctl_Linux_amd64.tar.gz
    rm eksctl_Linux_amd64.tar.gz

    # Create k6 load test script
    cat > /home/ec2-user/pravah_100k_load_test.js << 'K6SCRIPT'
    import http from 'k6/http';
    import { check, sleep } from 'k6';
    import { Rate, Trend } from 'k6/metrics';

    const errorRate = new Rate('errors');
    const edgeLatency = new Trend('edge_latency', true);

    // Target: Pravah Edge ALB endpoint
    const EDGE_URL = __ENV.EDGE_URL || 'http://localhost:3001';

    export const options = {
      scenarios: {
        // Ramp-up to 100k RPS
        ramp_to_100k: {
          executor: 'ramping-arrival-rate',
          startRate: 100,
          timeUnit: '1s',
          preAllocatedVUs: 500,
          maxVUs: 2000,
          stages: [
            { duration: '10s', target: 1000 },    // Warm-up: 1k RPS
            { duration: '10s', target: 5000 },     // Ramp: 5k RPS
            { duration: '10s', target: 10000 },    // Ramp: 10k RPS
            { duration: '10s', target: 50000 },    // Ramp: 50k RPS
            { duration: '30s', target: 100000 },   // PEAK: 100k RPS sustained
            { duration: '10s', target: 50000 },    // Cool-down
            { duration: '10s', target: 1000 },     // Wind-down
          ],
        },
      },
      thresholds: {
        http_req_duration: ['p(95)<50', 'p(99)<100'],  // p95 < 50ms, p99 < 100ms
        errors: ['rate<0.01'],                          // <1% error rate
      },
    };

    export default function () {
      // Test 1: Edge /metrics endpoint (lightweight health check)
      const metricsRes = http.get(`$${EDGE_URL}/metrics`);
      check(metricsRes, {
        'metrics status 200': (r) => r.status === 200,
      });
      errorRate.add(metricsRes.status !== 200);
      edgeLatency.add(metricsRes.timings.duration);
    }

    export function handleSummary(data) {
      const p50 = data.metrics.http_req_duration.values['p(50)'];
      const p95 = data.metrics.http_req_duration.values['p(95)'];
      const p99 = data.metrics.http_req_duration.values['p(99)'];
      const rps = data.metrics.http_reqs.values['rate'];
      const total = data.metrics.http_reqs.values['count'];

      console.log('=================================================================');
      console.log('🏁 PRAVAH CDN — 100K RPS AWS EKS LOAD TEST RESULTS');
      console.log('=================================================================');
      console.log(`  Total Requests:    $${total}`);
      console.log(`  Throughput:        $${rps.toFixed(1)} RPS`);
      console.log(`  p50 Latency:       $${p50.toFixed(2)} ms`);
      console.log(`  p95 Latency:       $${p95.toFixed(2)} ms`);
      console.log(`  p99 Latency:       $${p99.toFixed(2)} ms`);
      console.log('=================================================================');

      return {
        'stdout': JSON.stringify(data, null, 2),
        '/home/ec2-user/results.json': JSON.stringify(data, null, 2),
      };
    }
    K6SCRIPT

    chown ec2-user:ec2-user /home/ec2-user/pravah_100k_load_test.js
    echo "Load generator setup complete!" > /home/ec2-user/setup-done.txt
  USERDATA

  tags = {
    Name = "${var.cluster_name}-load-generator"
  }
}
