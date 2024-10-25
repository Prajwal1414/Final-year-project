import { CreateServiceCommand, ECSClient } from "@aws-sdk/client-ecs";

const ecsClient = new ECSClient({
  region: "",
  credentials: {
    accessKeyId: "",
    secretAccessKey: "",
  },
});

export default ecsClient;
