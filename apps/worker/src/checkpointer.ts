import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

/** 官方 PostgreSQL 检查点保存器复用共享连接池与超时配置，在独立 langgraph schema 中维护图状态。 */
export async function createPostgresCheckpointer(
  pool: ConstructorParameters<typeof PostgresSaver>[0],
): Promise<PostgresSaver> {
  const checkpointer = new PostgresSaver(pool, undefined, { schema: "langgraph" });
  await checkpointer.setup();
  return checkpointer;
}
