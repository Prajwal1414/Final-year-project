import { CreateServiceCommand, ECSClient } from "@aws-sdk/client-ecs";

const ecsClient = new ECSClient({
  region: "ap-south-1",
  credentials: {
    accessKeyId: "",
    secretAccessKey: "",
  },
});

export default ecsClient;
