/** Static constants that are not parameterized via CDK context. */
export const ALB_HTTP_PORT = 80;
export const ALB_HTTPS_PORT = 443;

/** ECR pull and Secrets Manager access require outbound HTTPS. */
export const OUTBOUND_HTTPS_PORT = 443;
export const DNS_PORT = 53;

/** ALB health check configuration. */
export const HEALTH_CHECK_INTERVAL_SECONDS = 30;
export const HEALTH_CHECK_TIMEOUT_SECONDS = 5;
export const HEALTH_CHECK_HEALTHY_COUNT = 2;
export const HEALTH_CHECK_UNHEALTHY_COUNT = 3;

/** CloudWatch alarm evaluation. */
export const ALARM_EVALUATION_PERIODS = 3;
export const ALARM_PERIOD_SECONDS = 60;

/** ECS deployment circuit breaker. Rolls back if the new task set fails to stabilize. */
export const ECS_CIRCUIT_BREAKER_ENABLED = true;
