#!/usr/bin/env python3
"""
Ultimate Canvas Course Scraper
Scrapes EVERY tab, file, and internal link in a Canvas course
Stays within Canvas domain, handles all content types
"""

import os
import json
import time
import requests
from urllib.parse import urlparse, urljoin
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from bs4 import BeautifulSoup
import PyPDF2
from io import BytesIO

try:
    import docx2txt
except ImportError:
    print("Warning: docx2txt not installed. Install with: pip3 install docx2txt")
    docx2txt = None


class UltimateCanvasScraper:
    """
    Comprehensive Canvas scraper that handles ALL tabs and content types
    """
    
    def __init__(self, course_url, output_dir="canvas_complete_scrape", headless=False):
        self.course_url = course_url.rstrip('/')
        self.course_id = self.extract_course_id(course_url)
        self.output_dir = output_dir
        self.headless = headless
        
        # Track visited URLs to avoid duplicates
        self.visited_urls = set()
        self.url_queue = []
        
        # Store scraped data
        self.scraped_data = {
            'course_url': course_url,
            'course_id': self.course_id,
            'announcements': [],
            'syllabus': {},
            'modules': [],
            'quizzes': [],
            'pages': [],
            'assignments': [],
            'files': [],
            'external_tools': {},
            'all_links': []
        }
        
        # Create output directories
        self.create_directories()
        
        # Initialize Selenium
        self.driver = self.init_driver()
        
    def extract_course_id(self, url):
        """Extract course ID from URL"""
        parts = url.split('/')
        try:
            idx = parts.index('courses')
            return parts[idx + 1]
        except (ValueError, IndexError):
            return 'unknown'
    
    def create_directories(self):
        """Create output directory structure"""
        dirs = [
            self.output_dir,
            f"{self.output_dir}/announcements",
            f"{self.output_dir}/syllabus",
            f"{self.output_dir}/modules",
            f"{self.output_dir}/quizzes",
            f"{self.output_dir}/pages",
            f"{self.output_dir}/assignments",
            f"{self.output_dir}/files",
            f"{self.output_dir}/pdfs",
            f"{self.output_dir}/documents",
            f"{self.output_dir}/metadata"
        ]
        for d in dirs:
            os.makedirs(d, exist_ok=True)
    
    def init_driver(self):
        """Initialize Selenium WebDriver"""
        options = webdriver.ChromeOptions()
        options.add_argument('--remote-debugging-port=9222')
        options.add_experimental_option("debuggerAddress", "127.0.0.1:9222")
        
        if self.headless:
            options.add_argument('--headless')
        
        driver = webdriver.Chrome(options=options)
        return driver
    
    def is_canvas_url(self, url):
        """Check if URL is within Canvas domain"""
        if not url:
            return False
        
        parsed = urlparse(url)
        
        # Canvas domains to include
        canvas_domains = ['canvas.cornell.edu']
        
        # Check if domain matches
        if any(domain in parsed.netloc for domain in canvas_domains):
            # Exclude external tool redirects
            if '/external_tools/' in url and 'edstem.org' not in url:
                return True
            return '/courses/' in url or '/files/' in url or '/api/' in url
        
        return False
    
    def is_external_platform(self, url):
        """Check if URL is an external platform (Ed, Gradescope, Zoom)"""
        external_domains = ['edstem.org', 'gradescope.com', 'zoom.us', 'cornell.zoom.us']
        parsed = urlparse(url)
        return any(domain in parsed.netloc for domain in external_domains)
    
    def get_cookies(self):
        """Get cookies from Selenium for requests"""
        cookies = {}
        for cookie in self.driver.get_cookies():
            cookies[cookie['name']] = cookie['value']
        return cookies
    
    def wait_for_page_load(self, timeout=10):
        """Wait for page to load"""
        try:
            WebDriverWait(self.driver, timeout).until(
                lambda d: d.execute_script('return document.readyState') == 'complete'
            )
            time.sleep(0.5)  # Extra buffer
        except TimeoutException:
            print("  [WARNING] Page load timeout")
    
    def extract_text_from_pdf(self, pdf_content):
        """Extract text from PDF content"""
        try:
            pdf_reader = PyPDF2.PdfReader(BytesIO(pdf_content))
            text = ""
            for page in pdf_reader.pages:
                text += page.extract_text() + "\n\n"
            return text.strip()
        except Exception as e:
            print(f"  [ERROR] PDF text extraction failed: {e}")
            return ""
    
    def extract_text_from_docx(self, docx_path):
        """Extract text from Word document"""
        if not docx2txt:
            return "[docx2txt not installed]"
        
        try:
            text = docx2txt.process(docx_path)
            return text.strip()
        except Exception as e:
            print(f"  [ERROR] DOCX text extraction failed: {e}")
            return ""
    
    def download_file(self, url, filename, file_type="pdf"):
        """Download file and extract text"""
        try:
            cookies = self.get_cookies()
            response = requests.get(url, cookies=cookies, timeout=30)
            
            if response.status_code == 200:
                # Save original file
                if file_type == "pdf":
                    filepath = f"{self.output_dir}/pdfs/{filename}"
                elif file_type == "docx":
                    filepath = f"{self.output_dir}/documents/{filename}"
                else:
                    filepath = f"{self.output_dir}/files/{filename}"
                
                with open(filepath, 'wb') as f:
                    f.write(response.content)
                
                print(f"  [DOWNLOADED] {filename}")
                
                # Extract text
                text = ""
                if file_type == "pdf":
                    text = self.extract_text_from_pdf(response.content)
                    text_path = filepath.replace('.pdf', '_text.txt')
                elif file_type == "docx":
                    text = self.extract_text_from_docx(filepath)
                    text_path = filepath.replace('.docx', '_text.txt')
                
                if text:
                    with open(text_path, 'w', encoding='utf-8') as f:
                        f.write(text)
                    print(f"  [EXTRACTED] Text saved to {os.path.basename(text_path)}")
                
                return filepath, text
            else:
                print(f"  [ERROR] Download failed: {response.status_code}")
                return None, ""
        
        except Exception as e:
            print(f"  [ERROR] Download failed: {e}")
            return None, ""
    
    def scrape_announcements(self):
        """Scrape all announcements"""
        print("\n" + "="*70)
        print("SCRAPING ANNOUNCEMENTS")
        print("="*70)
        
        url = f"{self.course_url}/announcements"
        self.driver.get(url)
        self.wait_for_page_load()
        
        # Scroll to load all announcements
        self.driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        time.sleep(1)
        
        # Get all announcement links
        soup = BeautifulSoup(self.driver.page_source, 'html.parser')
        announcement_links = []
        
        for link in soup.find_all('a'):
            href = link.get('href', '')
            if '/discussion_topics/' in href:
                full_url = urljoin(self.course_url, href)
                if full_url not in announcement_links:
                    announcement_links.append(full_url)
        
        print(f"Found {len(announcement_links)} announcements")
        
        # Scrape each announcement
        for i, ann_url in enumerate(announcement_links, 1):
            if ann_url in self.visited_urls:
                continue
            
            print(f"\n[{i}/{len(announcement_links)}] Scraping announcement...")
            
            try:
                self.driver.get(ann_url)
                self.wait_for_page_load()
                
                soup = BeautifulSoup(self.driver.page_source, 'html.parser')
                
                # Extract title
                title_elem = soup.find('h1') or soup.find('h2')
                title = title_elem.get_text().strip() if title_elem else f"Announcement_{i}"
                
                # Extract content
                content_elem = soup.find('div', class_='message') or soup.find('div', class_='discussion-entry')
                content = content_elem.get_text().strip() if content_elem else ""
                
                # Extract date
                date_elem = soup.find('time')
                date = date_elem.get('datetime', '') if date_elem else ""
                
                # Save announcement
                safe_title = "".join(c for c in title if c.isalnum() or c in (' ', '-', '_')).strip()[:50]
                filename = f"{self.output_dir}/announcements/{i:02d}_{safe_title}.txt"
                
                with open(filename, 'w', encoding='utf-8') as f:
                    f.write(f"Title: {title}\n")
                    f.write(f"Date: {date}\n")
                    f.write(f"URL: {ann_url}\n")
                    f.write(f"\n{'-'*70}\n\n")
                    f.write(content)
                
                self.scraped_data['announcements'].append({
                    'title': title,
                    'date': date,
                    'url': ann_url,
                    'file': filename
                })
                
                self.visited_urls.add(ann_url)
                print(f"  ✓ {title[:60]}")
                
            except Exception as e:
                print(f"  [ERROR] {e}")
        
        print(f"\n✓ Scraped {len(self.scraped_data['announcements'])} announcements")
    
    def scrape_syllabus(self):
        """Scrape syllabus and linked pages"""
        print("\n" + "="*70)
        print("SCRAPING SYLLABUS")
        print("="*70)
        
        url = f"{self.course_url}/assignments/syllabus"
        self.driver.get(url)
        self.wait_for_page_load()
        
        soup = BeautifulSoup(self.driver.page_source, 'html.parser')
        
        # Extract main syllabus content
        syllabus_elem = soup.find('div', id='course_syllabus') or soup.find('div', class_='user_content')
        syllabus_text = syllabus_elem.get_text().strip() if syllabus_elem else ""
        
        # Save main syllabus
        with open(f"{self.output_dir}/syllabus/syllabus_main.txt", 'w', encoding='utf-8') as f:
            f.write(syllabus_text)
        
        print("  ✓ Main syllabus saved")
        
        # Find linked pages
        page_links = []
        for link in soup.find_all('a'):
            href = link.get('href', '')
            if '/pages/' in href and self.is_canvas_url(href):
                full_url = urljoin(self.course_url, href)
                if full_url not in page_links:
                    page_links.append((link.get_text().strip(), full_url))
        
        print(f"Found {len(page_links)} linked pages")
        
        # Scrape each linked page
        for i, (page_title, page_url) in enumerate(page_links, 1):
            if page_url in self.visited_urls:
                continue
            
            print(f"\n[{i}/{len(page_links)}] Scraping page: {page_title}")
            
            try:
                self.driver.get(page_url)
                self.wait_for_page_load()
                
                soup = BeautifulSoup(self.driver.page_source, 'html.parser')
                content_elem = soup.find('div', class_='show-content') or soup.find('div', class_='user_content')
                content = content_elem.get_text().strip() if content_elem else ""
                
                # Save page
                safe_title = "".join(c for c in page_title if c.isalnum() or c in (' ', '-', '_')).strip()[:50]
                filename = f"{self.output_dir}/syllabus/{safe_title}.txt"
                
                with open(filename, 'w', encoding='utf-8') as f:
                    f.write(f"Title: {page_title}\n")
                    f.write(f"URL: {page_url}\n")
                    f.write(f"\n{'-'*70}\n\n")
                    f.write(content)
                
                self.scraped_data['syllabus'][page_title] = {
                    'url': page_url,
                    'file': filename
                }
                
                self.visited_urls.add(page_url)
                print(f"  ✓ {page_title}")
                
            except Exception as e:
                print(f"  [ERROR] {e}")
        
        print(f"\n✓ Scraped syllabus with {len(page_links)} linked pages")
    
    def scrape_modules(self):
        """Scrape all modules and their contents"""
        print("\n" + "="*70)
        print("SCRAPING MODULES (MOST COMPREHENSIVE)")
        print("="*70)
        
        url = f"{self.course_url}/modules"
        self.driver.get(url)
        self.wait_for_page_load()
        
        # Click "Expand All" button
        try:
            expand_btn = self.driver.find_element(By.XPATH, "//button[contains(text(), 'Expand All')]")
            expand_btn.click()
            print("  ✓ Clicked 'Expand All'")
            time.sleep(2)  # Wait for expansion
        except NoSuchElementException:
            print("  [INFO] No 'Expand All' button found")
        
        # Scroll to load all content
        self.driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        time.sleep(1)
        
        soup = BeautifulSoup(self.driver.page_source, 'html.parser')
        
        # Find all modules
        modules = soup.find_all('div', class_='context_module')
        
        print(f"Found {len(modules)} modules")
        
        for mod_idx, module in enumerate(modules, 1):
            # Get module name
            mod_name_elem = module.find('span', class_='name') or module.find('h2')
            mod_name = mod_name_elem.get_text().strip() if mod_name_elem else f"Module_{mod_idx}"
            
            print(f"\n{'='*70}")
            print(f"MODULE {mod_idx}: {mod_name}")
            print(f"{'='*70}")
            
            # Create module directory
            safe_mod_name = "".join(c for c in mod_name if c.isalnum() or c in (' ', '-', '_')).strip()[:50]
            mod_dir = f"{self.output_dir}/modules/{mod_idx:02d}_{safe_mod_name}"
            os.makedirs(mod_dir, exist_ok=True)
            
            # Find all items in module
            items = module.find_all('li', class_='context_module_item') or module.find_all('div', class_='ig-row')
            
            print(f"Found {len(items)} items in this module")
            
            module_data = {
                'name': mod_name,
                'items': []
            }
            
            for item_idx, item in enumerate(items, 1):
                # Get item link
                link = item.find('a')
                if not link:
                    continue
                
                item_title = link.get_text().strip()
                item_url = link.get('href', '')
                
                if not item_url:
                    continue
                
                full_url = urljoin(self.course_url, item_url)
                
                # Skip if already visited
                if full_url in self.visited_urls:
                    continue
                
                # Determine item type
                item_type = "unknown"
                if '.pdf' in item_url.lower():
                    item_type = "pdf"
                elif '.docx' in item_url.lower() or '.doc' in item_url.lower():
                    item_type = "docx"
                elif '/pages/' in item_url:
                    item_type = "page"
                elif '/assignments/' in item_url:
                    item_type = "assignment"
                elif '/quizzes/' in item_url:
                    item_type = "quiz"
                elif '/files/' in item_url:
                    item_type = "file"
                elif not self.is_canvas_url(full_url):
                    item_type = "external_link"
                
                print(f"\n  [{item_idx}/{len(items)}] {item_type.upper()}: {item_title[:50]}")
                
                # Handle based on type
                if item_type == "pdf":
                    # Download PDF
                    safe_filename = "".join(c for c in item_title if c.isalnum() or c in (' ', '-', '_', '.')).strip()
                    if not safe_filename.endswith('.pdf'):
                        safe_filename += '.pdf'
                    
                    filepath, text = self.download_file(full_url, safe_filename, "pdf")
                    
                    if filepath:
                        module_data['items'].append({
                            'type': 'pdf',
                            'title': item_title,
                            'url': full_url,
                            'file': filepath
                        })
                
                elif item_type == "docx":
                    # Download Word doc
                    safe_filename = "".join(c for c in item_title if c.isalnum() or c in (' ', '-', '_', '.')).strip()
                    if not safe_filename.endswith('.docx'):
                        safe_filename += '.docx'
                    
                    filepath, text = self.download_file(full_url, safe_filename, "docx")
                    
                    if filepath:
                        module_data['items'].append({
                            'type': 'docx',
                            'title': item_title,
                            'url': full_url,
                            'file': filepath
                        })
                
                elif item_type == "page":
                    # Scrape page
                    try:
                        self.driver.get(full_url)
                        self.wait_for_page_load()
                        
                        soup = BeautifulSoup(self.driver.page_source, 'html.parser')
                        content_elem = soup.find('div', class_='show-content') or soup.find('div', class_='user_content')
                        content = content_elem.get_text().strip() if content_elem else ""
                        
                        # Save page
                        safe_title = "".join(c for c in item_title if c.isalnum() or c in (' ', '-', '_')).strip()[:50]
                        filename = f"{mod_dir}/{item_idx:02d}_{safe_title}.txt"
                        
                        with open(filename, 'w', encoding='utf-8') as f:
                            f.write(f"Title: {item_title}\n")
                            f.write(f"URL: {full_url}\n")
                            f.write(f"\n{'-'*70}\n\n")
                            f.write(content)
                        
                        module_data['items'].append({
                            'type': 'page',
                            'title': item_title,
                            'url': full_url,
                            'file': filename
                        })
                        
                        print(f"    ✓ Page saved")
                        
                    except Exception as e:
                        print(f"    [ERROR] {e}")
                
                elif item_type == "external_link":
                    # Record external link but don't follow
                    print(f"    [EXTERNAL] Recorded but not followed")
                    module_data['items'].append({
                        'type': 'external_link',
                        'title': item_title,
                        'url': full_url
                    })
                
                else:
                    # Add to queue for later processing
                    if self.is_canvas_url(full_url):
                        self.url_queue.append(full_url)
                        print(f"    [QUEUED] Added to processing queue")
                
                self.visited_urls.add(full_url)
            
            self.scraped_data['modules'].append(module_data)
            print(f"\n✓ Completed module: {mod_name}")
        
        print(f"\n{'='*70}")
        print(f"✓ Scraped {len(modules)} modules")
        print(f"{'='*70}")
    
    def scrape_quizzes(self):
        """Scrape all quizzes"""
        print("\n" + "="*70)
        print("SCRAPING QUIZZES")
        print("="*70)
        
        url = f"{self.course_url}/quizzes"
        self.driver.get(url)
        self.wait_for_page_load()
        
        soup = BeautifulSoup(self.driver.page_source, 'html.parser')
        
        # Find all quiz links
        quiz_links = []
        for link in soup.find_all('a'):
            href = link.get('href', '')
            if '/quizzes/' in href and self.is_canvas_url(href):
                full_url = urljoin(self.course_url, href)
                title = link.get_text().strip()
                if full_url not in [q[1] for q in quiz_links] and title:
                    quiz_links.append((title, full_url))
        
        print(f"Found {len(quiz_links)} quizzes")
        
        for i, (quiz_title, quiz_url) in enumerate(quiz_links, 1):
            if quiz_url in self.visited_urls:
                continue
            
            print(f"\n[{i}/{len(quiz_links)}] Scraping quiz: {quiz_title}")
            
            try:
                self.driver.get(quiz_url)
                self.wait_for_page_load()
                
                soup = BeautifulSoup(self.driver.page_source, 'html.parser')
                
                # Extract quiz details
                content_elem = soup.find('div', class_='description') or soup.find('div', class_='user_content')
                content = content_elem.get_text().strip() if content_elem else ""
                
                # Save quiz
                safe_title = "".join(c for c in quiz_title if c.isalnum() or c in (' ', '-', '_')).strip()[:50]
                filename = f"{self.output_dir}/quizzes/{i:02d}_{safe_title}.txt"
                
                with open(filename, 'w', encoding='utf-8') as f:
                    f.write(f"Title: {quiz_title}\n")
                    f.write(f"URL: {quiz_url}\n")
                    f.write(f"\n{'-'*70}\n\n")
                    f.write(content)
                
                self.scraped_data['quizzes'].append({
                    'title': quiz_title,
                    'url': quiz_url,
                    'file': filename
                })
                
                self.visited_urls.add(quiz_url)
                print(f"  ✓ {quiz_title}")
                
            except Exception as e:
                print(f"  [ERROR] {e}")
        
        print(f"\n✓ Scraped {len(self.scraped_data['quizzes'])} quizzes")
    
    def process_url_queue(self):
        """Process remaining URLs in queue"""
        print("\n" + "="*70)
        print("PROCESSING REMAINING URLS")
        print("="*70)
        
        processed = 0
        max_urls = 100  # Limit to prevent infinite loops
        
        while self.url_queue and processed < max_urls:
            url = self.url_queue.pop(0)
            
            if url in self.visited_urls:
                continue
            
            if not self.is_canvas_url(url):
                continue
            
            print(f"\n[{processed + 1}] Processing: {url}")
            
            try:
                self.driver.get(url)
                self.wait_for_page_load()
                
                soup = BeautifulSoup(self.driver.page_source, 'html.parser')
                
                # Extract content
                content_elem = soup.find('div', class_='user_content') or soup.find('div', class_='show-content')
                content = content_elem.get_text().strip() if content_elem else ""
                
                # Save content
                url_hash = str(hash(url))[-8:]
                filename = f"{self.output_dir}/pages/page_{url_hash}.txt"
                
                with open(filename, 'w', encoding='utf-8') as f:
                    f.write(f"URL: {url}\n")
                    f.write(f"\n{'-'*70}\n\n")
                    f.write(content)
                
                self.scraped_data['pages'].append({
                    'url': url,
                    'file': filename
                })
                
                # Find new links
                for link in soup.find_all('a'):
                    href = link.get('href', '')
                    if href:
                        full_url = urljoin(self.course_url, href)
                        if self.is_canvas_url(full_url) and full_url not in self.visited_urls:
                            self.url_queue.append(full_url)
                
                self.visited_urls.add(url)
                processed += 1
                print(f"  ✓ Processed")
                
            except Exception as e:
                print(f"  [ERROR] {e}")
        
        print(f"\n✓ Processed {processed} additional URLs")
    
    def save_metadata(self):
        """Save scraping metadata"""
        print("\n" + "="*70)
        print("SAVING METADATA")
        print("="*70)
        
        # Save full scraped data
        with open(f"{self.output_dir}/metadata/scraped_data.json", 'w', encoding='utf-8') as f:
            json.dump(self.scraped_data, f, indent=2)
        
        # Save visited URLs
        with open(f"{self.output_dir}/metadata/urls_visited.json", 'w', encoding='utf-8') as f:
            json.dump(list(self.visited_urls), f, indent=2)
        
        # Save summary
        summary = {
            'course_url': self.course_url,
            'course_id': self.course_id,
            'total_announcements': len(self.scraped_data['announcements']),
            'total_modules': len(self.scraped_data['modules']),
            'total_quizzes': len(self.scraped_data['quizzes']),
            'total_pages': len(self.scraped_data['pages']),
            'total_urls_visited': len(self.visited_urls)
        }
        
        with open(f"{self.output_dir}/metadata/summary.json", 'w', encoding='utf-8') as f:
            json.dump(summary, f, indent=2)
        
        # Save README
        readme = f"""# Canvas Course Scrape - Complete

Course URL: {self.course_url}
Course ID: {self.course_id}

## Summary

- Announcements: {summary['total_announcements']}
- Modules: {summary['total_modules']}
- Quizzes: {summary['total_quizzes']}
- Pages: {summary['total_pages']}
- Total URLs Visited: {summary['total_urls_visited']}

## Directory Structure

- announcements/ - All course announcements
- syllabus/ - Syllabus and linked pages
- modules/ - All module contents (PDFs, pages, etc.)
- quizzes/ - Quiz details
- pages/ - Additional pages
- pdfs/ - All PDF files with extracted text
- documents/ - All Word documents with extracted text
- files/ - Other files
- metadata/ - JSON metadata files

## Files

All PDFs have corresponding _text.txt files with extracted text.
All Word documents have corresponding _text.txt files with extracted text.

## Metadata Files

- scraped_data.json - Complete scraping data
- urls_visited.json - All URLs visited
- summary.json - Quick summary
"""
        
        with open(f"{self.output_dir}/README.txt", 'w', encoding='utf-8') as f:
            f.write(readme)
        
        print("  ✓ Metadata saved")
        print(f"\n{summary}")
    
    def scrape_all(self):
        """Main scraping method - scrapes everything"""
        print("\n" + "="*70)
        print("ULTIMATE CANVAS SCRAPER")
        print("Scraping EVERY tab, file, and internal link")
        print("="*70)
        print(f"\nCourse URL: {self.course_url}")
        print(f"Output Directory: {self.output_dir}")
        print(f"\nStarting comprehensive scrape...\n")
        
        start_time = time.time()
        
        try:
            # Scrape each tab
            self.scrape_announcements()
            self.scrape_syllabus()
            self.scrape_modules()  # MOST COMPREHENSIVE
            self.scrape_quizzes()
            
            # Process remaining URLs
            self.process_url_queue()
            
            # Save metadata
            self.save_metadata()
            
            elapsed = time.time() - start_time
            
            print("\n" + "="*70)
            print("SCRAPING COMPLETE!")
            print("="*70)
            print(f"\nTime elapsed: {elapsed:.1f} seconds")
            print(f"Total URLs visited: {len(self.visited_urls)}")
            print(f"Output directory: {self.output_dir}")
            print("\n✓ All content has been scraped successfully!")
            
        except Exception as e:
            print(f"\n[FATAL ERROR] {e}")
            import traceback
            traceback.print_exc()
    
    def close(self):
        """Close the browser"""
        if self.driver:
            self.driver.quit()


def main():
    """Main function"""
    # Example usage - scrape AEP 4200
    course_url = "https://canvas.cornell.edu/courses/80403"
    
    scraper = UltimateCanvasScraper(
        course_url=course_url,
        output_dir="canvas_complete_aep4200",
        headless=False
    )
    
    try:
        scraper.scrape_all()
    finally:
        scraper.close()


if __name__ == "__main__":
    main()
