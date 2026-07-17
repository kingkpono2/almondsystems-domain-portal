<?php
$file = __DIR__ . '/almondshipping-1.0.0.zip';
if (!is_file($file)) {
    http_response_code(404);
    exit('Download not found.');
}
header('Content-Type: application/zip');
header('Content-Disposition: attachment; filename="almondshipping-1.0.0.zip"');
header('Content-Length: ' . filesize($file));
header('X-Content-Type-Options: nosniff');
readfile($file);
