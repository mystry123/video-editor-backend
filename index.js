"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};

Object.defineProperty(exports, "__esModule", { value: true });
exports.deployLambdaFunction = void 0;
const lambda_1 = require("@remotion/lambda");
const lambda_client_1 = require("@remotion/lambda-client");
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
// Load environment variables from .env file
dotenv_1.default.config()
const deployLambdaFunction = async () => {
    try {
        // Step 1: Deploy a function
        console.log('Deploying Lambda function...');
        // Make sure AWS SDK can find credentials
        process.env.AWS_REGION = 'ap-northeast-2';

        console.log(".env",process.env)
        // const {functionName} = await deployFunction({
        //     region: 'ap-south-1',
        //     timeoutInSeconds: 10 * 60, // do this 15 min
        //     memorySizeInMb: 2048,
        //     createCloudWatchLogGroup: true,
        // });
        // console.log(`Function deployed successfully: ${functionName}`);
        // Step 2: Create or get an S3 bucket
        console.log('Getting or creating S3 bucket...');
        const { bucketName } = await (0, lambda_1.getOrCreateBucket)({
            region: 'ap-south-1',
            enableFolderExpiry: true
        });
        console.log(`Using bucket: ${bucketName}`);
        // Correct path to the project root
        // const projectRoot = path_1.default.resolve(__dirname, "../../../");
        // Step 3: Deploy the site
        console.log('Deploying site to S3...');
        // // Use relative paths instead of absolute paths for better portability
        // const entryPoint = path.resolve(projectRoot, 'app/remotion/index.tsx');
        // console.log(`Using entry point: ${entryPoint}`);
        // // Create a custom webpack override function that matches the local bundling approach
        // const customWebpackOverride = (webpackConfig: any) => {
        //     console.log('Setting up webpack aliases, project root:', projectRoot);
        //     return {
        //         ...webpackConfig,
        //         resolve: {
        //             ...webpackConfig.resolve,
        //             alias: {
        //                 ...webpackConfig.resolve?.alias,
        //                 "~": path.resolve(projectRoot, "app"),
        //                 // Ensure React and ReactDOM are resolved to a single instance
        //                 'react': path.resolve(projectRoot, 'node_modules/react'),
        //                 'react-dom': path.resolve(projectRoot, 'node_modules/react-dom'),
        //             },
        //             // Ensure proper module resolution
        //             modules: [
        //                 path.resolve(projectRoot, 'node_modules'),
        //                 'node_modules',
        //             ],
        //         },
        //     };
        // };
        // Deploy the site with the custom webpack override
        // const {serveUrl} = await deploySite({
        //     bucketName,
        //     entryPoint,
        //     region: 'ap-south-1',
        //     siteName: 'hypergro-video-editor', // Use a consistent name for redeployments
        //     options: {
        //         webpackOverride: customWebpackOverride,
        //     },
        // });
        const serveUrl = "https://remotionlambda-apsouth1-18mo7g0y5p.s3.ap-south-1.amazonaws.com/sites/video-editor-2026-PRODUCTION/index.html";
        // Step 4: Get compatible functions
        console.log('Getting compatible functions...');
        const functions = await (0, lambda_1.getFunctions)({
            region: 'ap-south-1',
            compatibleOnly: true,
        });

        // console
        if (functions.length === 0) {
            throw new Error('No compatible functions found');
        }
        console.log("functions", functions)
        const lambdaFunctionName = functions[0].functionName;
        console.log(`Using function: ${lambdaFunctionName}`);
        // Step 5: Render a video with retry logic for rate limiting
        console.log('Starting video render...');
        let renderRetries = 0;
        const maxRenderRetries = 5;
        let renderId, renderBucketName;
        console.log("Starting", Date.now());
        try {
            let options = {
                region: 'ap-south-1',
                functionName: lambdaFunctionName,
                serveUrl,
                composition: 'VideoEditor', // Replace with your actual composition ID
                  inputProps:  {
                  "projectSettings": {
                    "width": 1920,
                    "height": 1080,
                    "name": "New Project",
                    "fps": 30,
                    "outputFormat": "mp4",
                    "duration": 10,
                    "backgroundColor": "#ffffff"
                  },
                  "elements": [
                    {
                      "id": "77beb5ee-32cf-4333-aca6-7b0b06d1e847",
                      "type": "shape",
                      "name": "Rectangle",
                      "track": 1,
                      "time": 0,
                      "duration": 10,
                      "x": "46.87296549479167%",
                      "y": "45.27777777777778%",
                      "width": "46.770833333333336%",
                      "height": "26.666666666666668%",
                      "locked": false,
                      "visible": true,
                      "opacity": 1,
                      "zIndex": 0,
                      "fillColor": "rgba(199, 199, 199, 1)",
                      "strokeColor": "#4F46E5",
                      "strokeWidth": 0,
                      "xRotation": 0,
                      "shapeType": "rectangle"
                    }
                  ]
                },  

                codec: 'h264',
                imageFormat: 'jpeg',
                maxRetries: 3,
                framesPerLambda: 40,
              audioCodec: 'mp3',
              chromiumOptions: {
                gl: 'swangle',
              },
         
                 logLevel: "verbose",
                privacy: 'public',
                bucketName:"remotionlambda-apsouth1-18mo7g0y5p",
                // concurrencyPerLambda: 2, // Limit concurrent executions per Lambda
            };
            const result = await (0, lambda_client_1.renderMediaOnLambda)(options);
            renderId = result.renderId;
            renderBucketName = result.bucketName;
        }
        catch (error) {
            // Check if it's a rate limiting error
            if (error?.$metadata?.httpStatusCode === 429 ||
                (error.name === 'TooManyRequestsException') ||
                error.message?.includes('Rate Exceeded')) {
                renderRetries++;
                const backoffTime = 1000 * Math.pow(2, renderRetries);
                console.log(`Rate limit exceeded when starting render. Retrying in ${backoffTime / 1000} seconds... (Attempt ${renderRetries} of ${maxRenderRetries})`);
                if (renderRetries >= maxRenderRetries) {
                    console.error('Max retries exceeded for render start');
                    throw error;
                }
                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, backoffTime));
            }
            else {
                // For other errors, rethrow
                console.error('Error starting render:', error);
                throw error;
            }
        }
        if (!renderId || !renderBucketName) {
            throw new Error('Failed to start render after multiple attempts');
        }
        // Step 6: Monitor render progress with exponential backoff for rate limiting
        console.log('Monitoring render progress...');
        let retryCount = 0;
        const maxRetries = 10;
        const initialBackoffMs = 1000; // Start with 1 second
        while (true) {
            try {
                // Wait before checking progress (increases with each retry)
                const backoffTime = initialBackoffMs * Math.pow(2, retryCount);
                await new Promise((resolve) => setTimeout(resolve, backoffTime));
                const progress = await (0, lambda_client_1.getRenderProgress)({
                    renderId,
                    bucketName: renderBucketName,
                    functionName: lambdaFunctionName,
                    region: 'ap-south-1',
                });
                // Reset retry count on successful API call
                retryCount = 0;
                console.log(`Progress: ${progress.overallProgress}%`);
                if (progress.done) {
                    console.log('Render finished!', progress.outputFile);
                    break;
                }
                if (progress.fatalErrorEncountered) {
                    console.error('Error encountered', progress.errors);
                    throw new Error('Render failed');
                }
            }
            catch (error) {
                // Handle rate limiting errors specifically
                if (error?.$metadata?.httpStatusCode === 429 ||
                    (error.name === 'TooManyRequestsException') ||
                    error.message?.includes('Rate Exceeded')) {
                    retryCount++;
                    const backoffTime = initialBackoffMs * Math.pow(2, retryCount);
                    console.log(`Rate limit exceeded. Retrying in ${backoffTime / 1000} seconds... (Attempt ${retryCount} of ${maxRetries})`);
                    // If we've exceeded max retries, throw the error
                    if (retryCount >= maxRetries) {
                        console.error('Max retries exceeded for rate limiting');
                        throw error;
                    }
                    // Continue to next iteration with increased backoff
                    continue;
                }
                // For other errors, rethrow
                console.error('Error checking render progress:', error);
                throw error;
            }
        }
        return {
            functionName: lambdaFunctionName,
            bucketName,
            serveUrl
        };
    }
    catch (error) {
        console.error('Deployment failed:', error);
        throw error;
    }
};
exports.deployLambdaFunction = deployLambdaFunction;
// Execute the deployment
// Uncomment this when ready to run the script
deployLambdaFunction()
    .then((result) => {
    console.log('Deployment successful:', result);
})
    .catch((error) => {
    console.error('Deployment failed:', error);
    process.exit(1);
});
