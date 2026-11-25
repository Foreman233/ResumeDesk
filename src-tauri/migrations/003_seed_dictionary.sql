INSERT INTO skills(name, category) VALUES
('Excel','通用办公'),('Word','通用办公'),('PowerPoint','通用办公'),('项目管理','通用办公'),
('SQL','数据分析'),('Python','数据分析'),('Power BI','数据分析'),('Tableau','数据分析'),
('统计分析','数据分析'),('数据可视化','数据分析'),('ETL','数据分析'),
('JavaScript','软件开发'),('TypeScript','软件开发'),('React','软件开发'),('Vue','软件开发'),
('Java','软件开发'),('C++','软件开发'),('C#','软件开发'),('Git','软件开发'),('Docker','软件开发'),
('软件测试','软件开发'),('Rust','软件开发'),('Node.js','软件开发'),('Linux','软件开发'),
('内容营销','市场营销'),('SEO','市场营销'),('广告投放','市场营销'),('用户运营','市场营销'),
('市场调研','市场营销'),('财务分析','财务'),('财务报表','财务'),('预算管理','财务'),
('会计核算','财务'),('审计','财务'),('招聘','人力资源'),('绩效管理','人力资源'),
('薪酬福利','人力资源'),('员工关系','人力资源'),('培训与发展','人力资源');

WITH aliases(name, alias) AS (VALUES
('Excel','Microsoft Excel'),('Excel','电子表格'),('Word','Microsoft Word'),('PowerPoint','PPT'),
('项目管理','project management'),('SQL','结构化查询语言'),('Power BI','PowerBI'),('统计分析','statistical analysis'),
('数据可视化','data visualization'),('ETL','数据抽取转换加载'),('JavaScript','ECMAScript'),
('React','React.js'),('Vue','Vue.js'),('C#','C Sharp'),('软件测试','software testing'),
('Node.js','NodeJS'),('内容营销','content marketing'),('SEO','搜索引擎优化'),('广告投放','media buying'),
('用户运营','user operations'),('市场调研','market research'),('财务分析','financial analysis'),
('财务报表','financial statements'),('预算管理','budget management'),('会计核算','accounting'),
('审计','audit'),('招聘','talent acquisition'),('招聘','recruitment'),('绩效管理','performance management'),
('薪酬福利','compensation and benefits'),('员工关系','employee relations'),('培训与发展','learning and development')
)
INSERT INTO skill_aliases(skill_id, alias) SELECT skills.id, aliases.alias FROM aliases JOIN skills USING(name);
