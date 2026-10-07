"""Synthetic STEP fixtures; native writer is a build-time fixture authoring tool only."""
import re
from pathlib import Path
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeFace
from OCP.BRep import BRep_Builder
from OCP.TopoDS import TopoDS_Compound, TopoDS_Shell, TopoDS
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE
from OCP.TopLoc import TopLoc_Location
from OCP.gp import gp_Trsf,gp_Vec,gp_Pnt
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorGen, XCAFDoc_ColorSurf
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDocStd import TDocStd_Document
from OCP.TDataStd import TDataStd_Name
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.Interface import Interface_Static
from OCP.IFSelect import IFSelect_RetDone

def document():
 d=TDocStd_Document(TCollection_ExtendedString('XmlXCAF'))
 XCAFApp_Application.GetApplication_s().NewDocument(TCollection_ExtendedString('MDTV-XCAF'),d)
 return d,XCAFDoc_DocumentTool.ShapeTool_s(d.Main()),XCAFDoc_DocumentTool.ColorTool_s(d.Main())
def name(l,n): TDataStd_Name.Set_s(l,TCollection_ExtendedString(n))
def rgb(r,g,b):return Quantity_Color(r,g,b,Quantity_TOC_RGB)
def location(x,y,z):
 t=gp_Trsf();t.SetTranslation(gp_Vec(x,y,z));return TopLoc_Location(t)
def assembly(st,n):
 c=TopoDS_Compound();BRep_Builder().MakeCompound(c);a=st.AddShape(c,True);name(a,n);return a
def write(d,st,filename):
 st.UpdateAssemblies();w=STEPCAFControl_Writer();w.SetColorMode(True);w.SetNameMode(True)
 Interface_Static.SetCVal_s('write.step.schema','AP214IS');assert w.Transfer(d);assert w.Write(str(filename))==IFSelect_RetDone
 # Stable synthetic fixture header: no workstation, author or wall-clock values.
 text=filename.read_text();text=re.sub(r"FILE_NAME\(.*?\);", "FILE_NAME('synthetic.step','2000-01-01T00:00:00',(''),(''),'Open CASCADE','Synthetic WireHub regression','');",text,flags=re.S)
 filename.write_text(text)
def instances(out):
 d,st,ct=document();a=assembly(st,'Synthetic assembly')
 p=st.AddShape(BRepPrimAPI_MakeBox(2,3,1).Shape(),False);name(p,'Synthetic repeated component');ct.SetColor(p,rgb(.2,.2,.8),XCAFDoc_ColorSurf)
 for label,delta,color in [('Synthetic red occurrence',0,rgb(.8,.1,.1)),('Synthetic green occurrence',5,rgb(.1,.8,.1))]:
  l=st.AddComponent(a,p,location(delta,0,0));name(l,label);ct.SetColor(l,color,XCAFDoc_ColorSurf)
 write(d,st,out/'occurrence-colors.step')
def faces(out):
 d,st,ct=document();shape=BRepPrimAPI_MakeBox(2,3,1).Shape();p=st.AddShape(shape,False);name(p,'Synthetic face-styled component');ct.SetColor(p,rgb(.4,.2,.6),XCAFDoc_ColorSurf)
 ex=TopExp_Explorer(shape,TopAbs_FACE);f=st.AddSubShape(p,ex.Current());name(f,'Synthetic yellow face');ct.SetColor(f,rgb(.9,.8,.1),XCAFDoc_ColorSurf)
 write(d,st,out/'face-colors.step')
def board(out):
 d,st,ct=document();a=assembly(st,'Synthetic board assembly')
 p=st.AddShape(BRepPrimAPI_MakeBox(10,8,1).Shape(),False);name(p,'synthetic_pcb');ct.SetColor(p,rgb(.1,.4,.1),XCAFDoc_ColorSurf);l=st.AddComponent(a,p,location(0,0,0));name(l,'Synthetic laminate')
 for z,reverse,label in [(1.05,False,'Synthetic top_soldermask'),(-.05,True,'Synthetic bottom_soldermask')]:
  poly=BRepBuilderAPI_MakePolygon()
  for x,y in [(0,0),(10,0),(10,8),(0,8)]:poly.Add(gp_Pnt(x,y,z))
  poly.Close();face=BRepBuilderAPI_MakeFace(poly.Wire()).Face()
  if reverse:face=face.Reversed()
  shell=TopoDS_Shell();b=BRep_Builder();b.MakeShell(shell);b.Add(shell,face)
  p=st.AddShape(shell,False);name(p,'synthetic_soldermask');ct.SetColor(p,rgb(.1,.3,.1),XCAFDoc_ColorSurf);l=st.AddComponent(a,p,location(0,0,0));name(l,label)
 write(d,st,out/'named-board-coatings.step')
def nested(out):
 d,st,ct=document();outer=assembly(st,'Synthetic nested assembly');inner=assembly(st,'Synthetic inner product')
 shape=BRepPrimAPI_MakeBox(2,3,1).Shape();p=st.AddShape(shape,False);name(p,'Synthetic nested component');ct.SetColor(p,rgb(.8,.4,.1),XCAFDoc_ColorSurf)
 face=st.AddSubShape(p,TopExp_Explorer(shape,TopAbs_FACE).Current());ct.SetColor(face,rgb(.9,.8,.1),XCAFDoc_ColorSurf)
 c=st.AddComponent(inner,p,location(2,3,1));name(c,'Synthetic nested occurrence')
 for label,delta in [('Synthetic inner A',10),('Synthetic inner B',30)]:
  c=st.AddComponent(outer,inner,location(delta,0,0));name(c,label)
 write(d,st,out/'nested-location-colors.step')
def coincident(out):
 d,st,ct=document();a=assembly(st,'Synthetic coincident assembly')
 p=st.AddShape(BRepPrimAPI_MakeBox(2,3,1).Shape(),False);name(p,'Synthetic coincident product');ct.SetColor(p,rgb(.2,.2,.8),XCAFDoc_ColorSurf)
 for color in [rgb(.8,.1,.1),rgb(.1,.8,.1)]:
  l=st.AddComponent(a,p,location(0,0,0));name(l,'Synthetic coincident occurrence');ct.SetColor(l,color,XCAFDoc_ColorSurf)
 write(d,st,out/'coincident-occurrence-colors.step')
out=Path(__file__).parent;out.mkdir(exist_ok=True)
instances(out);faces(out);board(out);nested(out);coincident(out)
print('Generated five synthetic STEP fixtures')
