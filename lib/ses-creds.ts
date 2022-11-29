import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as custom from 'aws-cdk-lib/custom-resources';
import { Construct, IDependable } from 'constructs';
import * as path from 'path';

interface Props {
  accessKeyVersion?: number;
  keyArn?: string;
  parameterPrefix: string;
}

export class SesCreds extends Construct {
  public readonly usernameParameter: ssm.IParameter;
  public readonly passwordParameter: ssm.IParameter;
  public readonly dependencies: readonly IDependable[];

  constructor(
    scope: Construct,
    id: string,
    { accessKeyVersion = 1, keyArn, parameterPrefix }: Props
  ) {
    super(scope, id);

    const smtpUser = new iam.User(this, 'smtpUser');
    smtpUser.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendRawEmail'],
        resources: ['*'],
      })
    );

    const smtpUserAccessKey = new iam.AccessKey(this, 'smtpUserAccessKey', {
      user: smtpUser,
      status: iam.AccessKeyStatus.ACTIVE,
      serial: accessKeyVersion,
    });

    this.usernameParameter =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        'usernameParameter',
        {
          parameterName: `${parameterPrefix}/username`,
        }
      );
    this.passwordParameter =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        'passwordParameter',
        {
          parameterName: `${parameterPrefix}/password`,
        }
      );

    const fn = new lambda.SingletonFunction(this, 'fn', {
      uuid: '97c80fb6-3b7c-4d92-aaef-c481f4793049',
      code: new lambda.AssetCode(path.join(__dirname, '../ses-handler')),
      runtime: lambda.Runtime.NODEJS_16_X,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(5),
      logRetention: 180,
      environment: {
        SES_KEY_ARN: keyArn ?? '',
        SES_PARAMETER_PREFIX: parameterPrefix,
      },
    });
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
        resources: [
          this.usernameParameter.parameterArn,
          this.passwordParameter.parameterArn,
        ],
      })
    );

    if (keyArn) {
      kms.Key.fromKeyArn(this, 'kmsKey', keyArn).grantEncrypt(fn);
    }

    const provider = new custom.Provider(this, 'provider', {
      onEventHandler: fn,
      logRetention: 1,
    });

    const username = new cdk.CustomResource(this, 'username', {
      serviceToken: provider.serviceToken,
      properties: {
        Key: smtpUserAccessKey.accessKeyId,
        ParameterType: 'username',
      },
    });
    const password = new cdk.CustomResource(this, 'password', {
      serviceToken: provider.serviceToken,
      properties: {
        Key: smtpUserAccessKey.secretAccessKey.unsafeUnwrap(),
        ParameterType: 'password',
      },
    });

    this.dependencies = [username, password];
  }
}
