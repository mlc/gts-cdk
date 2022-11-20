## DRAFT, NOT WORKING, DO NOT RELY ON THIS

This is a draft of getting [gotosocial][] working in AWS with [CDK][]

### To try it

- clone this repo
- `yarn install`
- edit `bin/cdk.ts`. Most settings are optional and you can delete them if you don't want them.
- `yarn cdk deploy`

### What doesn't work

- you have to engage in some very seriously weird hackery to run `gotosocial admin` commands to create users
- something's up with media uploads, i think it doesn't work, but maybe it partially works, idek

### Expensive things if you actually ran this

- an RDS instance (database server) $0.016/hr
- an ECS fargate "cluster" $0.00995748/hr (but maybe this is underprovisioned, idk)
- an Application Load Balancer $0.0225/hr
- a NAT gateway $0.045/hr
- plus storage, bandwidth, etc. maybe i'm forgetting something?

estimated total cost: $67+ / month, i guess. my test instance was up for only an hour or two before i deleted it, what do i know.

[gotosocial]: https://gotosocial.org/
[cdk]: https://aws.amazon.com/cdk/
