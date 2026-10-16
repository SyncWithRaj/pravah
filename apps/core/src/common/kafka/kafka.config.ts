import { SASLOptions } from 'kafkajs';

export function getKafkaSaslConfig(
  username?: string,
  password?: string,
  mechanismStr?: string,
): SASLOptions | undefined {
  if (!username) {
    return undefined;
  }
  const mechanism = (mechanismStr || 'scram-sha-256').toLowerCase();
  if (mechanism === 'plain') {
    return {
      mechanism: 'plain',
      username,
      password: password ?? '',
    };
  }
  if (mechanism === 'scram-sha-512') {
    return {
      mechanism: 'scram-sha-512',
      username,
      password: password ?? '',
    };
  }
  return {
    mechanism: 'scram-sha-256',
    username,
    password: password ?? '',
  };
}
