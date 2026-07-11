process.env.RUNNINGHUB_CANARY_TASK = "R3-8O_RUNNINGHUB_ENTERPRISE_KEY_6S_SINGLE_SUBMIT_CANARY";
process.env.RUNNINGHUB_CANARY_STRATEGY_REPORT_PATH = "data/reports/r3_8n_provider_access_strategy_decision.json";
process.env.RUNNINGHUB_CANARY_OUTPUT_REPORT_PATH = "data/reports/r3_8o_runninghub_enterprise_key_6s_single_submit_canary_result.json";
process.env.RUNNINGHUB_CANARY_OUTPUT_DIR_RELATIVE = "data/media/provider-canary/r3-8o-runninghub-enterprise-key-6s-real-keyframe/";
process.env.RUNNINGHUB_CANARY_AUTHORIZATION_ENV_NAME = "R3_8O_AUTHORIZATION_SHA256";
process.env.RUNNINGHUB_CANARY_AUTHORIZATION_EXPECTED_SHA256 = "07adac0bfb9b35a3175e555f81579f6ff3512a178d9d88b61c76cc58f034bf65";
process.env.RUNNINGHUB_CANARY_VALIDATION_COMMAND_NAME = "npm run r3:8o:live";
process.env.RUNNINGHUB_CANARY_SCRIPT_PATH_FOR_REPORT = "scripts/r3-8o-runninghub-enterprise-key-6s-single-submit-canary.ts";

await import("./r3-8m-runninghub-6s-single-submit-canary.js");
