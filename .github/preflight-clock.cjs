// Linux monotonic timestamps can be compared between the parent and its child.
process.env.GYB_BENCH_ENTRY = process.hrtime.bigint().toString();
