const videoInput = document.getElementById('videoInput');
const overlayCanvas = document.getElementById('overlayCanvas');
const stopwatchDisplay = document.getElementById('stopwatch-display');
const statusIndicator = document.getElementById('status-indicator');
const container = document.querySelector('.container'); // To adjust canvas/video size

let faceDetectionInitialized = false;
let mediaStream = null;

// Stopwatch variables
let startTime = 0;
let elapsedTime = 0;
let timerInterval = null;
let isRunning = false;
let isPausedByDetection = true; // Start paused

// Face detection state
let isPersonPresent = false;
let isHeadDown = false;
let isStudying = false; // Combines isPersonPresent and isHeadDown

// Configuration
const detectionInterval = 100; // How often to run face detection (milliseconds). requestAnimationFrame handles actual frame rate.
const headDownThreshold = 0.1; // Heuristic threshold: Nose tip significantly below eye level relative to face size. Needs tuning.

// --- Helper Functions ---

function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const pad = (num) => num.toString().padStart(2, '0');

    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function updateStopwatchDisplay() {
    const currentTime = Date.now();
    const currentElapsedTime = elapsedTime + (isRunning ? (currentTime - startTime) : 0);
    stopwatchDisplay.textContent = formatTime(currentElapsedTime);
}

function startStopwatch() {
    if (isRunning) return;
    isRunning = true;
    startTime = Date.now() - elapsedTime; // Resume from current elapsed time
    timerInterval = setInterval(updateStopwatchDisplay, 1000); // Update display every second
    console.log("Stopwatch Started");
}

function pauseStopwatch() {
    if (!isRunning) return;
    isRunning = false;
    clearInterval(timerInterval);
    elapsedTime += Date.now() - startTime; // Save current elapsed time
    console.log("Stopwatch Paused");
}

function setStatus(text, className) {
    statusIndicator.textContent = text;
    statusIndicator.className = 'status-indicator ' + className; // Reset and add class
}

// Simple Head Posture Estimation (Pitch - looking up/down)
// This is a very basic heuristic. More accurate methods involve PnP algorithms and 3D models.
// We check if the nose tip is significantly below the line between the eyes.
function isLookingDown(landmarks, faceBox) {
    if (!landmarks || !faceBox) return false;

    // Landmark indices for eyes (approx average) and nose tip (approx)
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();
    const nose = landmarks.getNose();

    if (leftEye.length === 0 || rightEye.length === 0 || nose.length === 0) return false;

    // Average Y coordinate of the eyes
    const avgEyeY = (leftEye.reduce((sum, p) => sum + p.y, 0) / leftEye.length +
                     rightEye.reduce((sum, p) => sum + p.y, 0) / rightEye.length) / 2;

    // Y coordinate of the nose tip (using index 30 as a proxy)
    // The nose landmark points are [27..35], nose tip is roughly 30
    const noseTipY = landmarks.getNose()[3][1].y; // Index 3, point 1 of nose points (approx) - this index might vary based on face-api version/model, needs verification. Let's use a simple average or a key point if possible. A more stable key point is often landmark 30 itself from the full 68 set. Face-api landmarks can be accessed by index. Let's assume landmarks[30] is the nose tip y.
    // Re-checking face-api.js docs, landmark index 30 is indeed the nose tip in the 68-point model.
     try {
         // Access landmark by index for robustness
         const noseTip = landmarks.positions[30];
         if (!noseTip) return false; // Check if point exists

         const noseTipY_accurate = noseTip.y;

         // Calculate face height for normalization
         const faceHeight = faceBox.height;

         // If the nose tip is significantly below the average eye level
         // relative to face height, assume head is down.
         const relativeNoseY = (noseTipY_accurate - avgEyeY) / faceHeight;

         //console.log(`Avg Eye Y: ${avgEyeY.toFixed(2)}, Nose Tip Y: ${noseTipY_accurate.toFixed(2)}, Face Height: ${faceHeight.toFixed(2)}, Relative Y: ${relativeNoseY.toFixed(2)}`);

         return relativeNoseY > headDownThreshold; // Threshold needs tuning based on testing
     } catch (e) {
         console.error("Error calculating head posture:", e);
         return false;
     }
}


// --- Core Detection Loop ---

async function onPlay() {
    if (!faceDetectionInitialized) {
        console.warn("Face detection not initialized.");
        requestAnimationFrame(onPlay); // Keep trying
        return;
    }

    if (videoInput.paused || videoInput.ended) {
        // Handle video pause/end if necessary
        setStatus("Video Paused/Ended", "paused");
        isPersonPresent = false; // Assume not present if video is not playing
        isStudying = false;
        // Keep stopwatch paused
        requestAnimationFrame(onPlay);
        return;
    }

    // Resize canvas to match video dimensions
    const displaySize = { width: videoInput.width, height: videoInput.height };
    faceapi.matchDimensions(overlayCanvas, displaySize);

    // Perform face detection and landmark detection
    // Use tiny model for speed
    const detections = await faceapi.detectSingleFace(videoInput, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks();

    // Update study state based on detection
    isPersonPresent = !!detections; // True if detections is not null/undefined
    isHeadDown = false; // Reset head down status for this frame

    if (isPersonPresent && detections.landmarks && detections.detection) {
        // Check head posture if a face is detected
        isHeadDown = isLookingDown(detections.landmarks, detections.detection.box);

        // Draw detections on canvas (optional, can be removed)
        const resizedDetections = faceapi.resizeResults(detections, displaySize);
        overlayCanvas.getContext('2d').clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        faceapi.draw.drawDetections(overlayCanvas, resizedDetections);
        faceapi.draw.drawFaceLandmarks(overlayCanvas, resizedDetections);

        // Determine overall studying state
        isStudying = isPersonPresent && isHeadDown;

    } else {
        // No face detected or landmarks missing
        isStudying = false;
        // Clear canvas if no detection
        overlayCanvas.getContext('2d').clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }

    // --- Stopwatch Control Logic (Check state every second) ---
    // We run detection frequently with rAF, but check the study state for
    // stopwatch control at a defined interval to avoid rapid toggling.
    // A simple way is to average or debounce the 'isStudying' state,
    // or just check the current state frequently. Let's react immediately for now.

    const previousIsRunning = isRunning;

    if (isStudying) {
        setStatus("Studying...", "studying");
        if (isPausedByDetection) { // Only resume if paused by detection, not manually (if manual pause was added)
             startStopwatch();
             isPausedByDetection = false; // No longer paused by detection criteria
        }
    } else {
         // Not studying: Not present OR head up
        if (isPersonPresent) {
             setStatus("Distracted...", "distracted");
        } else {
             setStatus("Person Not Found", "distracted"); // Use distracted class for visual consistency
        }

        if (isRunning) {
             pauseStopwatch();
             isPausedByDetection = true; // Mark that it was paused due to detection criteria
        }
    }

    // Request the next frame
    requestAnimationFrame(onPlay);
}

// --- Initialization ---

async function initializeFaceDetection() {
    setStatus("Loading models...", "loading");
    try {
        const modelPath = '/models'; // Path relative to index.html

        await faceapi.nets.tinyFaceDetector.loadFromUri(modelPath);
        await faceapi.nets.faceLandmark68Net.loadFromUri(modelPath);
        // No need for faceRecognitionNet or ssdMobilenetv1 unless you plan to identify individuals
        // await faceapi.nets.faceRecognitionNet.loadFromUri(modelPath);
        // await faceapi.nets.ssdMobilenetv1.loadFromUri(modelPath); // Used by default detection, but tiny is faster

        faceDetectionInitialized = true;
        setStatus("Ready. Grant camera access.", "ready");
        console.log("Face API models loaded.");

        // Now attempt to get camera access
        await setupCamera();

    } catch (error) {
        console.error("Error loading face-api models:", error);
        setStatus("Error loading models!", "camera-error");
    }
}

async function setupCamera() {
    // Check for camera support
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus("Error: Camera not supported in this browser.", "camera-error");
        console.error("Camera not supported");
        return;
    }

    setStatus("Requesting camera access...", "loading"); // Loading color, but indicates next step

    try {
        // Request camera stream
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        mediaStream = stream;
        videoInput.srcObject = stream;

        // Add event listener to start detection when video plays
        videoInput.addEventListener('play', onPlay);

        setStatus("Granting camera access...", "loading"); // Keep loading status until video plays
        console.log("Camera stream obtained.");

        // Set initial dimensions on video load (important for canvas overlay)
         videoInput.addEventListener('loadedmetadata', () => {
            // Attempt to set video dimensions based on stream or set defaults
            const videoWidth = videoInput.videoWidth || 640;
            const videoHeight = videoInput.videoHeight || 480;
            videoInput.width = videoWidth;
            videoInput.height = videoHeight;

            // Also resize canvas/container to match or constrain video size
            // This makes the detection area match the visual area
            container.style.width = `${videoWidth}px`; // Or use a max-width from CSS
            // container.style.maxWidth = '900px'; // Example if container has max-width
            // camera-area width is already max-width: 400px;
             const aspectRatio = videoHeight / videoWidth;
             const cameraArea = document.querySelector('.camera-area');
             // Set video/canvas dimensions relative to camera-area parent
             videoInput.style.width = '100%';
             videoInput.style.height = 'auto'; // Let height be auto
             overlayCanvas.style.width = '100%';
             overlayCanvas.style.height = 'auto'; // Let height be auto

             // The onPlay function resizes canvas to actual videoPlaybackQuality dimensions
             // but setting the container size based on expected video size can help layout
             // It might be better to let CSS handle container size and rely on faceapi.matchDimensions inside onPlay

             setStatus("Camera Ready", "ready"); // Status updates once video is loaded/ready to play
        });


    } catch (error) {
        console.error("Error accessing camera:", error);
        setStatus("Error accessing camera!", "camera-error");
         // Stop the stopwatch if camera access fails after it was running
        if(isRunning) {
            pauseStopwatch();
            isPausedByDetection = true; // Mark as paused by system failure
        }
    }
}

// --- AdSense Integration (Optional - handled by script tag in HTML usually) ---
// If you need to dynamically load ads or push ad units via JS:
/*
function loadAdSense() {
    if (window.adsbygoogle && window.adsbygoogle.requestNonPersonalizedAds === undefined) {
        // Optional: Request non-personalized ads based on user consent (e.g., GDPR)
        // window.adsbygoogle.requestNonPersonalizedAds = 1; // Or 0 for personalized
    }
    // Push any ad units defined in HTML or dynamically create them
    // This is often done automatically if the script tag is present
    // For manually added units with data-ad-client and data-ad-slot:
    // (adsbygoogle = window.adsbygoogle || []).push({});
}
// Call this function after models load or on page load
// loadAdSense();
*/


// --- Start the process ---
// Initial call to load models and then set up the camera
initializeFaceDetection();

// Initial stopwatch display
updateStopwatchDisplay(); // Show 00:00:00 initially

// Ensure stopwatch starts paused visually
pauseStopwatch(); // Call pause initially to set isRunning=false and clearInterval (though timerInterval is null)
elapsedTime = 0; // Reset elapsed time

// The stopwatch will only START when the detection loop determines isStudying becomes true.