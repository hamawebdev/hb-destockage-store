// Placeholder (TOOL-2). Owner: jobs.
export default {
  async scheduled(_controller: ScheduledController, _env: unknown, _ctx: ExecutionContext): Promise<void> {
    // daily D1 -> R2 export lands in JOBS-*
  },
} satisfies ExportedHandler;
