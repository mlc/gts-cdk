import AWS from 'aws-sdk';
import { createHmac } from 'node:crypto';
import type { CdkCustomResourceHandler } from 'aws-lambda';

const SMTP_REGIONS = [
  'us-east-2', // US East (Ohio)
  'us-east-1', // US East (N. Virginia)
  'us-west-2', // US West (Oregon)
  'ap-south-1', // Asia Pacific (Mumbai)
  'ap-northeast-2', // Asia Pacific (Seoul)
  'ap-southeast-1', // Asia Pacific (Singapore)
  'ap-southeast-2', // Asia Pacific (Sydney)
  'ap-northeast-1', // Asia Pacific (Tokyo)
  'ca-central-1', // Canada (Central)
  'eu-central-1', // Europe (Frankfurt)
  'eu-west-1', // Europe (Ireland)
  'eu-west-2', // Europe (London)
  'sa-east-1', // South America (Sao Paulo)
  'us-gov-west-1', // AWS GovCloud (US)
];

// These values are required to calculate the signature. Do not change them.
const DATE = '11111111';
const SERVICE = 'ses';
const MESSAGE = 'SendRawEmail';
const TERMINAL = 'aws4_request';
const VERSION = Buffer.from([0x04]);

const region = process.env.AWS_REGION ?? '';

const ssm = new AWS.SSM({ region });
const sts = new AWS.STS({ region });

const sign = (key: Buffer, msg: string): Buffer =>
  createHmac('sha256', key).update(msg, 'utf8').digest();

const calculateKey = (secretAccessKey: string): string => {
  if (!SMTP_REGIONS.includes(region)) {
    throw new Error(`The ${region} region doesn't have an SMTP endpoint.`);
  }

  let signature = sign(Buffer.from('AWS4' + secretAccessKey, 'utf-8'), DATE);
  signature = sign(signature, region);
  signature = sign(signature, SERVICE);
  signature = sign(signature, TERMINAL);
  signature = sign(signature, MESSAGE);

  const versionAndSignature = Buffer.concat([VERSION, signature]);
  return versionAndSignature.toString('base64');
};

const parameterName = (parameter: string): string =>
  [process.env.SES_PARAMETER_PREFIX, parameter].join('/');

const computeArn = async (parameter: string): Promise<string> => {
  const name = parameterName(parameter);
  const { Account } = await sts.getCallerIdentity().promise();
  return [
    `arn:aws:ssm:${region}:${Account}:parameter`,
    name[0] === '/' ? '' : '/',
    parameterName(parameter),
  ].join('');
};

const putParameter = (value: string, parameter: string): Promise<string> =>
  ssm
    .putParameter({
      Type: 'SecureString',
      Name: parameterName(parameter),
      Value: value,
      KeyId: process.env.SES_KEY_ARN || undefined,
      Description: `SMTP ${parameter} for email communications`,
      Overwrite: true,
      Tier: 'Standard',
    })
    .promise()
    .then(() => computeArn(parameter));

const deleteParameter = (parameter: string): Promise<string> =>
  ssm
    .deleteParameter({
      Name: parameterName(parameter),
    })
    .promise()
    .then(() => computeArn(parameter));

export const handler: CdkCustomResourceHandler = async (event, context) => {
  const parameterType: string = event.ResourceProperties.ParameterType;
  const key: string = event.ResourceProperties.Key;
  let arn: string;

  switch (event.RequestType) {
    case 'Create':
    case 'Update':
      arn = await putParameter(
        parameterType === 'password' ? calculateKey(key) : key,
        parameterType
      );
      break;

    case 'Delete':
      arn = await deleteParameter(parameterType);
      break;

    default:
      throw new Error(`unexpected event type`);
  }

  return {
    PhysicalResourceId: arn,
  };
};
