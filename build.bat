@echo off
echo Building executable with pkg...
call npx pkg . --out-path dist

echo Copying ffmpeg.exe to dist folder...
copy node_modules\ffmpeg-static\ffmpeg.exe dist\

echo Done! The 'dist' folder now contains everything you need to sell the script.
